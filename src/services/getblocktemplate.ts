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
import { hash } from '../crypto/hash';
import { createHash } from 'crypto';
import { serialize, deserialize } from '../utils/bigint';

const logger = getLogger(__filename);

// template storage keys
const TEMPLATE_KEYS = {
  template: (id: string) => `gbt:template:${id}`,
  activeTemplates: 'gbt:active',
  currentTemplate: 'gbt:current',
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
  timestamp: number;
  resolve: (template: BlockTemplate) => void;
  timeout: NodeJS.Timeout;
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
  async getBlockTemplate(request: BlockTemplateRequest = {}): Promise<BlockTemplate> {
    // check for existing valid template
    const existing = await this.getCurrentTemplate();
    
    // handle longpoll request
    if (request.longpollId && existing) {
      return this.handleLongpoll(request.longpollId, existing);
    }
    
    // generate new template if needed
    if (!existing || await this.shouldRefreshTemplate(existing)) {
      return this.generateNewTemplate();
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
    
    // reconstruct block from template and submission
    const block = this.reconstructBlock(template, submission);
    
    // validate proof of work
    const blockHash = block.calculateHash();
    const targetBigInt = BigInt(`0x${template.target}`);
    const hashBigInt = BigInt(`0x${blockHash}`);
    
    if (hashBigInt > targetBigInt) {
      return { valid: false, error: 'Invalid proof of work' };
    }
    
    // submit to blockchain
    try {
      await this.blockchain.addBlock(block);
      return { valid: true };
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }
  
  // template generation
  private async generateNewTemplate(): Promise<BlockTemplate> {
    const height = await this.blockchain.getHeight();
    const previousBlock = await this.blockchain.getLatestBlock();
    const difficulty = await this.blockchain.getDifficulty();
    const chainConfig = this.blockchain.getChainConfig();
    
    if (!previousBlock) {
      throw new Error('No previous block found');
    }
    
    // get transactions from mempool
    const transactions = this.mempool.getTransactionsForBlock();
    
    // calculate fees
    const totalFees = transactions.reduce((sum, tx) => sum + (tx.fee || 0n), 0n);
    
    // calculate block reward
    const blockReward = this.blockchain.calculateBlockReward(height + 1);
    
    // create coinbase transaction
    const coinbaseTransaction: Transaction = {
      hash: '',
      from: '0'.repeat(34), // null address
      to: 'miner-address', // this will be replaced by actual miner
      amount: blockReward + totalFees,
      nonce: 0,
      timestamp: Date.now(),
      signature: '',
      fee: 0n
    };
    
    // calculate merkle root placeholder
    const allTransactions = [coinbaseTransaction, ...transactions];
    const merkleRoot = this.calculateMerkleRoot(allTransactions);
    
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
      height: height + 1,
      previousHash: previousBlock.hash,
      merkleRootPlaceholder: merkleRoot,
      timestamp: Date.now(),
      difficulty,
      chainVersionHash: chainConfig.chainVersionHash,
      
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
    
    // store in storage
    await this.storeTemplate(template);
    
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
  private async getCurrentTemplate(): Promise<BlockTemplate | null> {
    const templateId = await this.storage.getCustomData(TEMPLATE_KEYS.currentTemplate);
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
    await this.storage.setCustomData(TEMPLATE_KEYS.currentTemplate, template.templateId);
    
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
    
    // template unchanged, set up longpoll subscription
    return new Promise((resolve) => {
      const subscription: LongpollSubscription = {
        longpollId,
        templateId: currentTemplate.templateId,
        timestamp: Date.now(),
        resolve,
        timeout: setTimeout(() => {
          // timeout reached, return current template
          this.activeSubscriptions.delete(longpollId);
          resolve(currentTemplate);
        }, TEMPLATE_CONFIG.longpollTimeoutMs)
      };
      
      this.activeSubscriptions.set(longpollId, subscription);
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
      clearTimeout(subscription.timeout);
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
      submission.timestamp || template.timestamp,
      template.previousHash,
      [template.coinbaseTransaction, ...template.transactions],
      template.difficulty,
      template.chainVersionHash
    );
    
    block.nonce = submission.nonce;
    
    return block;
  }
  
  // calculate merkle root of transactions
  private calculateMerkleRoot(transactions: Transaction[]): string {
    if (transactions.length === 0) {
      return '0'.repeat(64);
    }
    
    let hashes = transactions.map(tx => 
      tx.hash || hash(serialize(tx), 'sha256')
    );
    
    while (hashes.length > 1) {
      const newHashes: string[] = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left;
        newHashes.push(hash(left + right, 'sha256'));
      }
      
      hashes = newHashes;
    }
    
    return hashes[0];
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
    const now = Date.now();
    
    // get all active templates
    const activeTemplates = await this.storage.getSetMembers(TEMPLATE_KEYS.activeTemplates);
    
    for (const templateId of activeTemplates) {
      const template = await this.getTemplate(templateId);
      
      if (!template || now > template.expiresAt) {
        // remove expired template
        await this.storage.deleteCustomData(TEMPLATE_KEYS.template(templateId));
        await this.storage.removeFromSet(TEMPLATE_KEYS.activeTemplates, templateId);
        
        logger.debug('Cleaned up expired template', { templateId });
      }
    }
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
        await this.invalidateAllTemplates();
        await this.generateNewTemplate();
      }
    }
  }
  
  // invalidate all templates
  private async invalidateAllTemplates(): Promise<void> {
    const activeTemplates = await this.storage.getSetMembers(TEMPLATE_KEYS.activeTemplates);
    
    for (const templateId of activeTemplates) {
      await this.storage.deleteCustomData(TEMPLATE_KEYS.template(templateId));
    }
    
    await this.storage.deleteCustomData(TEMPLATE_KEYS.activeTemplates);
    await this.storage.deleteCustomData(TEMPLATE_KEYS.currentTemplate);
    
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
      this.activeSubscriptions.delete(longpollId);
    }
    
    logger.info('GetBlockTemplate service shutdown complete');
  }
}