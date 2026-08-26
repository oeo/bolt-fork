import { getLogger } from '../utils/logger';
import type { 
  BlockTemplate, 
  BlockTemplateRequest, 
  BlockSubmission,
  Transaction 
} from '../types';
import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';
import type { StorageAdapter } from '../storage/adapter';
import { BlockClass } from '../core/block';
import { createCoinbaseTransaction } from '../core/transaction';
import { validateAddress } from '../crypto/address';
import { hash } from '../crypto/hash';
import { createHash } from 'crypto';
import { serialize, deserialize } from '../utils/bigint';

const logger = getLogger(__filename);

// template storage keys
const TEMPLATE_KEYS = {
  template: (id: string) => `gbt:template:${id}`,
  activeTemplates: 'gbt:active',
  currentTemplate: (payoutAddress: string) => `gbt:current:${payoutAddress}`,
  expiryIndex: (timestamp: number) => `gbt:expires:${timestamp}`,
  mempoolHash: 'gbt:mempool:hash',
  longpoll: (id: string) => `gbt:longpoll:${id}`,
  stats: 'gbt:stats'
};

// template lifecycle constants
const TEMPLATE_CONFIG = {
  defaultExpiryMs: 30 * 1000,
  maxConcurrentTemplates: 10,
  mempoolChangeThreshold: 0.1,
  cleanupIntervalMs: 10 * 1000,
  longpollTimeoutMs: 60 * 1000
};

interface LongpollSubscription {
  longpollId: string;
  templateId: string;
  payoutAddress: string;
  timestamp: number;
  resolve: (template: BlockTemplate) => void;
  timeout: NodeJS.Timeout;
  onChainChange: () => void;
}

export class GetBlockTemplateService {
  private blockchain: Blockchain;
  private mempool: Mempool;
  private storage: StorageAdapter;
  private cleanupTimer?: NodeJS.Timeout;
  private mempoolWatcher?: NodeJS.Timeout;
  private activeSubscriptions: Map<string, LongpollSubscription>;
  
  constructor(blockchain: Blockchain, mempool: Mempool, storage: StorageAdapter) {
    this.blockchain = blockchain;
    this.mempool = mempool;
    this.storage = storage;
    this.activeSubscriptions = new Map();
    
    this.startCleanupScheduler();
    this.startMempoolWatcher();
  }
  
  // main gbt interface
  async getBlockTemplate(request: BlockTemplateRequest): Promise<BlockTemplate> {
    const chainConfig = this.blockchain.getChainConfig();
    if (!validateAddress(request.payoutAddress, chainConfig.addressPrefix)) {
      throw new Error('Invalid payout address');
    }
    // check for existing valid template
    const existing = await this.getCurrentTemplate(request.payoutAddress);
    
    // generate new template if needed
    if (!existing || await this.shouldRefreshTemplate(existing)) {
      return this.generateNewTemplate(request.payoutAddress);
    }

    // handle longpoll request
    if (request.longpollId) {
      return this.handleLongpoll(request.longpollId, existing);
    }
    
    return existing;
  }
  
  // submit a mined block
  async submitBlock(submission: BlockSubmission): Promise<{ valid: boolean; error?: string }> {
    // validate submission against stored template
    const template = await this.getTemplate(submission.templateId);
    if (!template) {
      return { valid: false, error: 'Template not found or expired' };
    }
    if (submission.timestamp !== undefined && submission.timestamp !== template.timestamp) {
      return { valid: false, error: 'Submission timestamp does not match template' };
    }
    
    // reconstruct block from template and submission
    const block = this.reconstructBlock(template, submission);
    
    // validate proof of work
    const blockHash = block.calculateHash();
    const targetBigInt = BigInt(`0x${template.target}`);
    const hashBigInt = BigInt(`0x${blockHash}`);
    
    if (hashBigInt > targetBigInt) {
      return { valid: false, error: 'Invalid proof of work' };
    }
    
    let result;
    try {
      result = await this.blockchain.addBlock(block);
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
    return result;
  }
  
  // template generation
  private async generateNewTemplate(payoutAddress: string): Promise<BlockTemplate> {
    const previousBlock = await this.blockchain.getLatestBlock();
    const chainConfig = this.blockchain.getChainConfig();
    
    if (!previousBlock) {
      throw new Error('No previous block found');
    }
    const height = previousBlock.index + 1;
    const difficulty = await this.blockchain.getDifficulty(height);
    
    // get transactions from mempool
    const transactions = this.mempool.getTransactionsForBlock();
    
    // calculate fees
    const totalFees = transactions.reduce((sum, tx) => sum + (tx.fee || 0n), 0n);
    
    // calculate block reward
    const blockReward = this.blockchain.calculateBlockReward(height);
    
    // create coinbase transaction
    const timestamp = Math.max(Date.now(), previousBlock.timestamp + 1);
    const coinbaseTransaction = createCoinbaseTransaction(
      chainConfig.chainId,
      payoutAddress,
      blockReward,
      totalFees,
      timestamp
    ).toObject();
    const allTransactions = [coinbaseTransaction, ...transactions];
    const candidate = new BlockClass(
      height,
      timestamp,
      previousBlock.hash,
      allTransactions,
      difficulty,
      payoutAddress
    );
    await this.blockchain.prepareBlock(candidate);
    
    // generate template id
    const templateId = this.generateTemplateId();
    
    // generate longpoll id
    const longpollId = this.generateLongpollId();
    
    // calculate difficulty target
    const target = this.difficultyToTarget(difficulty);
    const bits = this.difficultyToBits(difficulty);
    
    // calculate block size estimate
    const blockSizeBytes = this.estimateBlockSize(allTransactions);
    
    // create template
    const template: BlockTemplate = {
      templateId,
      createdAt: Date.now(),
      expiresAt: Date.now() + TEMPLATE_CONFIG.defaultExpiryMs,
      
      version: 1,
      height,
      previousHash: previousBlock.hash,
      merkleRootPlaceholder: candidate.merkleRoot,
      stateRoot: candidate.stateRoot,
      timestamp,
      difficulty,
      
      target,
      bits,
      
      transactions,
      coinbaseTransaction,
      coinbaseValue: blockReward + totalFees,
      totalFees,
      blockReward,
      
      transactionCount: allTransactions.length,
      blockSizeBytes,
      sigOpsCount: this.countSigOps(allTransactions),
      
      longpollId,
      submitOld: false
    };
    
    let stale = false;
    await this.storage.withStateWrite(async () => {
      const currentTip = await this.blockchain.getLatestBlock();
      stale = !currentTip || currentTip.index !== previousBlock.index || currentTip.hash !== previousBlock.hash;
      if (!stale) await this.storeTemplate(template);
    });
    if (stale) return this.generateNewTemplate(payoutAddress);
    
    // notify longpoll subscribers
    this.notifyLongpollSubscribers(template);
    
    logger.info('Generated new block template', {
      templateId,
      height: template.height,
      transactionCount: template.transactionCount
    });
    
    return template;
  }
  
  // get current active template
  private async getCurrentTemplate(payoutAddress: string): Promise<BlockTemplate | null> {
    const templateId = await this.storage.getCustomData(TEMPLATE_KEYS.currentTemplate(payoutAddress));
    if (!templateId) return null;
    
    return this.getTemplate(templateId);
  }
  
  // get specific template by id
  private async getTemplate(templateId: string): Promise<BlockTemplate | null> {
    const data = await this.storage.getCustomData(TEMPLATE_KEYS.template(templateId));
    if (!data) return null;
    
    try {
      return this.deserializeTemplate(deserialize(data));
    } catch (error) {
      logger.error('Failed to deserialize template', { templateId, error });
      return null;
    }
  }
  
  // check if template should be refreshed
  private async shouldRefreshTemplate(template: BlockTemplate): Promise<boolean> {
    // check if expired
    if (Date.now() > template.expiresAt) {
      return true;
    }

    const tip = await this.blockchain.getLatestBlock();
    if (!tip || template.height !== tip.index + 1 || template.previousHash !== tip.hash) {
      return true;
    }
    
    // check if mempool changed significantly
    const currentHash = await this.calculateMempoolHash();
    const storedHash = await this.storage.getCustomData(TEMPLATE_KEYS.mempoolHash);
    
    if (currentHash !== storedHash) {
      const changeSignificance = await this.assessMempoolChange();
      if (changeSignificance > TEMPLATE_CONFIG.mempoolChangeThreshold) {
        return true;
      }
    }
    
    return false;
  }
  
  // store template in storage
  private async storeTemplate(template: BlockTemplate): Promise<void> {
    const serialized = serialize(this.serializeTemplate(template));
    
    // store template data
    await this.storage.setCustomData(
      TEMPLATE_KEYS.template(template.templateId),
      serialized,
      Math.floor(TEMPLATE_CONFIG.defaultExpiryMs / 1000)
    );
    
    // update active templates set
    await this.storage.addToSet(TEMPLATE_KEYS.activeTemplates, template.templateId);
    
    // set as current template
    await this.storage.setCustomData(
      TEMPLATE_KEYS.currentTemplate(template.coinbaseTransaction.to),
      template.templateId
    );
    
    // add to expiry index
    await this.storage.addToSet(
      TEMPLATE_KEYS.expiryIndex(template.expiresAt),
      template.templateId
    );
    
    // update mempool hash
    const mempoolHash = await this.calculateMempoolHash();
    await this.storage.setCustomData(TEMPLATE_KEYS.mempoolHash, mempoolHash);
  }
  
  // serialize template for storage
  private serializeTemplate(template: BlockTemplate): object {
    return {
      ...template,
      totalFees: template.totalFees.toString(),
      blockReward: template.blockReward.toString(),
      coinbaseValue: template.coinbaseValue.toString(),
      transactions: template.transactions.map(tx => ({
        ...tx,
        amount: tx.amount.toString(),
        fee: tx.fee?.toString() || '0'
      })),
      coinbaseTransaction: {
        ...template.coinbaseTransaction,
        amount: template.coinbaseTransaction.amount.toString(),
        fee: '0'
      }
    };
  }
  
  // deserialize template from storage
  private deserializeTemplate(data: any): BlockTemplate {
    return {
      ...data,
      totalFees: BigInt(data.totalFees),
      blockReward: BigInt(data.blockReward),
      coinbaseValue: BigInt(data.coinbaseValue),
      transactions: data.transactions.map((tx: any) => ({
        ...tx,
        amount: BigInt(tx.amount),
        fee: tx.fee ? BigInt(tx.fee) : 0n
      })),
      coinbaseTransaction: {
        ...data.coinbaseTransaction,
        amount: BigInt(data.coinbaseTransaction.amount),
        fee: 0n
      }
    };
  }
  
  // handle longpoll requests
  private async handleLongpoll(
    longpollId: string,
    currentTemplate: BlockTemplate
  ): Promise<BlockTemplate> {
    // check if template changed since last poll
    const lastTemplateId = await this.storage.getCustomData(
      TEMPLATE_KEYS.longpoll(longpollId)
    );
    
    if (lastTemplateId !== currentTemplate.templateId) {
      // template changed, return immediately
      await this.updateLongpollId(longpollId, currentTemplate.templateId);
      return currentTemplate;
    }

    const active = this.activeSubscriptions.get(longpollId);
    if (active) {
      clearTimeout(active.timeout);
      this.blockchain.off('block:added', active.onChainChange);
      this.activeSubscriptions.delete(longpollId);
      active.resolve(currentTemplate);
    }
    
    // template unchanged, set up longpoll subscription
    return new Promise((resolve) => {
      let subscription!: LongpollSubscription;
      const finish = (template: BlockTemplate): void => {
        if (this.activeSubscriptions.get(longpollId) !== subscription) return;
        clearTimeout(subscription.timeout);
        this.blockchain.off('block:added', subscription.onChainChange);
        this.activeSubscriptions.delete(longpollId);
        resolve(template);
      };
      let refreshing = false;
      const onChainChange = (): void => {
        if (refreshing) return;
        refreshing = true;
        void this.getBlockTemplate({ payoutAddress: currentTemplate.coinbaseTransaction.to })
          .then(finish)
          .catch(error => {
            refreshing = false;
            logger.error('Failed to refresh longpoll after chain change', { error });
          });
      };
      subscription = {
        longpollId,
        templateId: currentTemplate.templateId,
        payoutAddress: currentTemplate.coinbaseTransaction.to,
        timestamp: Date.now(),
        resolve,
        timeout: setTimeout(() => {
          void this.getBlockTemplate({ payoutAddress: currentTemplate.coinbaseTransaction.to })
            .then(finish)
            .catch(() => finish(currentTemplate));
        }, TEMPLATE_CONFIG.longpollTimeoutMs),
        onChainChange,
      };
      
      this.activeSubscriptions.set(longpollId, subscription);
      this.blockchain.on('block:added', onChainChange);
    });
  }
  
  // update longpoll id tracking
  private async updateLongpollId(longpollId: string, templateId: string): Promise<void> {
    await this.storage.setCustomData(
      TEMPLATE_KEYS.longpoll(longpollId),
      templateId,
      Math.floor(TEMPLATE_CONFIG.longpollTimeoutMs / 1000)
    );
  }
  
  // notify longpoll subscribers of new template
  private notifyLongpollSubscribers(newTemplate: BlockTemplate): void {
    for (const [longpollId, subscription] of this.activeSubscriptions) {
      if (subscription.payoutAddress !== newTemplate.coinbaseTransaction.to) continue;
      clearTimeout(subscription.timeout);
      this.blockchain.off('block:added', subscription.onChainChange);
      subscription.resolve(newTemplate);
      this.activeSubscriptions.delete(longpollId);
    }
  }
  
  // calculate mempool hash for change detection
  private async calculateMempoolHash(): Promise<string> {
    const stats = this.mempool.getStats();
    const transactions = this.mempool.getTransactions();
    
    // create hash from transaction hashes, fees, and mempool state
    const hashData = serialize({
      size: stats.size,
      totalFees: stats.totalFees,
      avgFeePerByte: stats.avgFeePerByte,
      txHashes: transactions.slice(0, 100).map(tx => tx.hash)
    });
    
    return hash(hashData, 'sha256');
  }
  
  // assess mempool change significance
  private async assessMempoolChange(): Promise<number> {
    // simple implementation: consider any change significant for now
    // this could be enhanced to calculate actual change percentage
    return 0.5;
  }
  
  // reconstruct block from template and submission
  private reconstructBlock(template: BlockTemplate, submission: BlockSubmission): BlockClass {
    const block = new BlockClass(
      template.height,
      template.timestamp,
      template.previousHash,
      [template.coinbaseTransaction, ...template.transactions],
      template.difficulty,
      template.coinbaseTransaction.to,
      template.stateRoot
    );
    
    block.nonce = submission.nonce;
    block.hash = block.calculateHash();
    
    return block;
  }
  
  // convert difficulty to target hex string
  private difficultyToTarget(difficulty: number): string {
    // target = 2^256 / difficulty
    // but we need to cap it at 2^256 - 1 for 64 hex chars
    const maxTarget = BigInt(2) ** BigInt(256) - BigInt(1);
    const target = maxTarget / BigInt(Math.floor(difficulty));
    const hex = target.toString(16);
    // ensure exactly 64 characters
    if (hex.length > 64) {
      return hex.substring(0, 64);
    }
    return hex.padStart(64, '0');
  }
  
  // convert difficulty to compact bits representation
  private difficultyToBits(difficulty: number): string {
    // simplified implementation for now
    const target = this.difficultyToTarget(difficulty);
    return target.substring(0, 8);
  }
  
  // estimate block size in bytes
  private estimateBlockSize(transactions: Transaction[]): number {
    // rough estimate: 80 bytes header + 250 bytes per transaction
    return 80 + (transactions.length * 250);
  }
  
  // count signature operations in transactions
  private countSigOps(transactions: Transaction[]): number {
    // simplified: 1 sigop per transaction
    return transactions.length;
  }
  
  // generate unique template id
  private generateTemplateId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `${timestamp}-${random}`;
  }
  
  // generate longpoll id
  private generateLongpollId(): string {
    return createHash('sha256')
      .update(Date.now().toString())
      .update(Math.random().toString())
      .digest('hex')
      .substring(0, 16);
  }
  
  // cleanup expired templates
  private async cleanupExpiredTemplates(): Promise<void> {
    await this.storage.withStateWrite(async () => {
      const now = Date.now();
      const activeTemplates = await this.storage.getSetMembers(TEMPLATE_KEYS.activeTemplates);

      for (const templateId of activeTemplates) {
        const template = await this.getTemplate(templateId);

        if (!template || now > template.expiresAt) {
          await this.storage.deleteCustomData(TEMPLATE_KEYS.template(templateId));
          await this.storage.removeFromSet(TEMPLATE_KEYS.activeTemplates, templateId);
          if (template) {
            const currentKey = TEMPLATE_KEYS.currentTemplate(template.coinbaseTransaction.to);
            if (await this.storage.getCustomData(currentKey) === templateId) {
              await this.storage.deleteCustomData(currentKey);
            }
          }

          logger.debug('Cleaned up expired template', { templateId });
        }
      }
    });
  }
  
  // start cleanup scheduler
  private startCleanupScheduler(): void {
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.cleanupExpiredTemplates();
      } catch (error) {
        logger.error('Error during template cleanup', { error });
      }
    }, TEMPLATE_CONFIG.cleanupIntervalMs);
  }
  
  // start mempool watcher
  private startMempoolWatcher(): void {
    this.mempoolWatcher = setInterval(async () => {
      try {
        await this.checkMempoolChanges();
      } catch (error) {
        logger.error('Error during mempool monitoring', { error });
      }
    }, 5000);
  }
  
  // check for mempool changes
  private async checkMempoolChanges(): Promise<void> {
    const currentHash = await this.calculateMempoolHash();
    const storedHash = await this.storage.getCustomData(TEMPLATE_KEYS.mempoolHash);
    
    if (currentHash !== storedHash) {
      const changeSignificance = await this.assessMempoolChange();
      
      if (changeSignificance > TEMPLATE_CONFIG.mempoolChangeThreshold) {
        logger.info('Significant mempool change detected, refreshing templates');
        const payouts = new Set<string>();
        for (const templateId of await this.storage.getSetMembers(TEMPLATE_KEYS.activeTemplates)) {
          const template = await this.getTemplate(templateId);
          if (template) payouts.add(template.coinbaseTransaction.to);
        }
        await this.invalidateAllTemplates();
        for (const payoutAddress of payouts) await this.generateNewTemplate(payoutAddress);
      }
    }
  }
  
  // invalidate all templates
  private async invalidateAllTemplates(): Promise<void> {
    await this.storage.withStateWrite(async () => {
      const activeTemplates = await this.storage.getSetMembers(TEMPLATE_KEYS.activeTemplates);

      for (const templateId of activeTemplates) {
        const template = await this.getTemplate(templateId);
        if (template) {
          const currentKey = TEMPLATE_KEYS.currentTemplate(template.coinbaseTransaction.to);
          if (await this.storage.getCustomData(currentKey) === templateId) {
            await this.storage.deleteCustomData(currentKey);
          }
        }
        await this.storage.deleteCustomData(TEMPLATE_KEYS.template(templateId));
      }

      await this.storage.deleteCustomData(TEMPLATE_KEYS.activeTemplates);
    });

    logger.info('Invalidated all templates');
  }
  
  // cleanup on shutdown
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    if (this.mempoolWatcher) {
      clearInterval(this.mempoolWatcher);
    }
    
    // clear all longpoll subscriptions
    for (const [longpollId, subscription] of this.activeSubscriptions) {
      clearTimeout(subscription.timeout);
      this.blockchain.off('block:added', subscription.onChainChange);
      this.activeSubscriptions.delete(longpollId);
    }
    
    logger.info('GetBlockTemplate service shutdown complete');
  }
}
