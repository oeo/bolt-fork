import { CanonicalTransition, StaleChainTipError, StorageAdapter } from './adapter';
import { Block, Transaction, AccountState } from '../types';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

/**
 * in-memory implementation of storage adapter
 * useful for testing and development
 */
export class MemoryAdapter extends StorageAdapter {
  private blocks: Map<number, Block> = new Map();
  private blockHashes: Map<string, number> = new Map();
  private accounts: Map<string, AccountState> = new Map();
  private transactions: Map<string, Transaction> = new Map();
  private txByAddress: Map<string, Set<string>> = new Map();
  private mempool: Map<string, Transaction> = new Map();
  private metadata: Map<string, any> = new Map();
  private latestBlock: Block | null = null;
  private chainHeight: number = -1;
  private cumulativeDifficulty: bigint = 0n;
  
  async connect(): Promise<void> {
    this.isConnected = true;
    logger.info('Memory storage adapter connected');
  }
  
  async close(): Promise<void> {
    this.isConnected = false;
    logger.info('Memory storage adapter disconnected');
  }
  
  async clear(): Promise<void> {
    this.checkConnection();
    this.blocks.clear();
    this.blockHashes.clear();
    this.accounts.clear();
    this.transactions.clear();
    this.txByAddress.clear();
    this.mempool.clear();
    this.metadata.clear();
    this.latestBlock = null;
    this.chainHeight = -1;
    this.cumulativeDifficulty = 0n;
    logger.warn('Cleared all data from memory');
  }
  
  async getStorageStats(): Promise<{
    used: number;
    keys: number;
    type: string;
  }> {
    this.checkConnection();
    
    // count total keys
    const totalKeys = 
      this.blocks.size + 
      this.blockHashes.size + 
      this.accounts.size + 
      this.transactions.size + 
      this.txByAddress.size +
      this.mempool.size +
      this.metadata.size;
    
    // rough estimate: 1KB per item average
    const estimatedBytes = totalKeys * 1024;
    
    return {
      used: estimatedBytes,
      keys: totalKeys,
      type: 'memory'
    };
  }
  
  // block operations
  
  async saveBlock(block: Block): Promise<void> {
    this.checkConnection();
    this.blocks.set(block.index, block);
    this.blockHashes.set(block.hash, block.index);
    
    if (block.index > this.chainHeight) {
      this.chainHeight = block.index;
      this.latestBlock = block;
    }
    
    logger.debug(`Saved block ${block.index} with hash ${block.hash}`);
  }

  async transitionCanonicalChain({
    expectedTip,
    expectedCumulativeDifficulty,
    ancestor,
    blocks,
    accountStates,
    cumulativeDifficulty,
  }: CanonicalTransition): Promise<void> {
    this.checkConnection();
    if (cumulativeDifficulty < 0n) throw new Error('Invalid cumulative difficulty');
    const actualTip = { height: this.chainHeight, hash: this.latestBlock?.hash ?? null };
    if (
      actualTip.height !== expectedTip.height ||
      actualTip.hash !== expectedTip.hash ||
      this.cumulativeDifficulty !== expectedCumulativeDifficulty
    ) {
      throw new StaleChainTipError(actualTip);
    }

    const ancestorBlock = ancestor.height >= 0 ? this.blocks.get(ancestor.height) : null;
    const ancestorMatches = ancestor.height === -1
      ? ancestor.hash === null
      : ancestorBlock?.hash === ancestor.hash;
    if (ancestor.height < -1 || ancestor.height > expectedTip.height || !ancestorMatches) {
      throw new Error('Invalid canonical ancestor');
    }

    let previousHash = ancestor.hash;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.index !== ancestor.height + i + 1 || block.previousHash !== (previousHash ?? '0'.repeat(64))) {
        throw new Error('Invalid replacement chain');
      }
      previousHash = block.hash;
    }

    const nextBlocks = new Map(this.blocks);
    const nextBlockHashes = new Map(this.blockHashes);
    for (const [height, block] of nextBlocks) {
      if (height <= ancestor.height) continue;
      nextBlocks.delete(height);
      nextBlockHashes.delete(block.hash);
    }
    for (const block of blocks) {
      const storedBlock = structuredClone(block);
      nextBlocks.set(block.index, storedBlock);
      nextBlockHashes.set(block.hash, block.index);
    }

    const nextTransactions = new Map<string, Transaction>();
    const nextTxByAddress = new Map<string, Set<string>>();
    for (const block of nextBlocks.values()) {
      for (const tx of block.transactions) {
        nextTransactions.set(tx.hash, tx);
        if (tx.from) {
          if (!nextTxByAddress.has(tx.from)) nextTxByAddress.set(tx.from, new Set());
          nextTxByAddress.get(tx.from)!.add(tx.hash);
        }
        if (!nextTxByAddress.has(tx.to)) nextTxByAddress.set(tx.to, new Set());
        nextTxByAddress.get(tx.to)!.add(tx.hash);
      }
    }

    const nextAccounts = new Map<string, AccountState>();
    for (const { address, state } of accountStates) {
      if (nextAccounts.has(address)) throw new Error(`Duplicate account state: ${address}`);
      nextAccounts.set(address, { ...state });
    }

    const finalHeight = blocks.at(-1)?.index ?? ancestor.height;
    this.blocks = nextBlocks;
    this.blockHashes = nextBlockHashes;
    this.transactions = nextTransactions;
    this.txByAddress = nextTxByAddress;
    this.accounts = nextAccounts;
    this.chainHeight = finalHeight;
    this.latestBlock = nextBlocks.get(finalHeight) ?? null;
    this.cumulativeDifficulty = cumulativeDifficulty;
  }
  
  async getBlock(height: number): Promise<Block | null> {
    this.checkConnection();
    const block = this.blocks.get(height);
    return block ? structuredClone(block) : null;
  }
  
  async getBlockByHash(hash: string): Promise<Block | null> {
    this.checkConnection();
    const height = this.blockHashes.get(hash);
    if (height === undefined) return null;
    const block = this.blocks.get(height);
    return block ? structuredClone(block) : null;
  }
  
  async getLatestBlock(): Promise<Block | null> {
    this.checkConnection();
    return this.latestBlock ? structuredClone(this.latestBlock) : null;
  }
  
  async getBlockRange(start: number, end: number): Promise<Block[]> {
    this.checkConnection();
    const blocks: Block[] = [];
    
    for (let i = start; i <= end; i++) {
      const block = this.blocks.get(i);
      if (block) blocks.push(structuredClone(block));
    }
    
    return blocks;
  }
  
  async getChainHeight(): Promise<number> {
    this.checkConnection();
    return this.chainHeight;
  }
  
  // account operations
  
  async getAccountState(address: string): Promise<AccountState | null> {
    this.checkConnection();
    const state = this.accounts.get(address);
    return state ? { ...state } : null;
  }
  
  async updateAccountState(address: string, state: AccountState): Promise<void> {
    this.checkConnection();
    this.accounts.set(address, state);
    logger.debug(`Updated account ${address}: balance=${state.balance}, nonce=${state.nonce}`);
  }
  
  async getAllAccountAddresses(): Promise<string[]> {
    this.checkConnection();
    return Array.from(this.accounts.keys());
  }
  
  // chain operations
  
  async getCumulativeDifficulty(): Promise<bigint> {
    this.checkConnection();
    return this.cumulativeDifficulty;
  }
  
  async updateCumulativeDifficulty(difficulty: bigint): Promise<void> {
    this.checkConnection();
    this.cumulativeDifficulty = difficulty;
    logger.debug(`Updated cumulative difficulty to ${difficulty}`);
  }
  
  // transaction operations
  
  async getTransaction(hash: string): Promise<Transaction | null> {
    this.checkConnection();
    return this.transactions.get(hash) || null;
  }
  
  async saveTransaction(tx: Transaction): Promise<void> {
    this.checkConnection();
    this.transactions.set(tx.hash, tx);
    
    // index by address
    if (tx.from) {
      if (!this.txByAddress.has(tx.from)) {
        this.txByAddress.set(tx.from, new Set());
      }
      this.txByAddress.get(tx.from)!.add(tx.hash);
    }
    
    if (!this.txByAddress.has(tx.to)) {
      this.txByAddress.set(tx.to, new Set());
    }
    this.txByAddress.get(tx.to)!.add(tx.hash);
    
    logger.debug(`Saved transaction ${tx.hash}`);
  }
  
  async getTransactionsByAddress(address: string): Promise<Transaction[]> {
    this.checkConnection();
    const txHashes = this.txByAddress.get(address);
    if (!txHashes) return [];
    
    const transactions: Transaction[] = [];
    for (const hash of txHashes) {
      const tx = this.transactions.get(hash);
      if (tx) transactions.push(tx);
    }
    
    return transactions;
  }
  
  // mempool operations
  
  async addToMempool(tx: Transaction): Promise<void> {
    this.checkConnection();
    this.mempool.set(tx.hash, tx);
    logger.debug(`Added transaction ${tx.hash} to mempool`);
  }
  
  async removeFromMempool(txHash: string): Promise<void> {
    this.checkConnection();
    this.mempool.delete(txHash);
    logger.debug(`Removed transaction ${txHash} from mempool`);
  }
  
  async getMempoolTransactions(): Promise<Transaction[]> {
    this.checkConnection();
    return Array.from(this.mempool.values());
  }
  
  async clearMempool(): Promise<void> {
    this.checkConnection();
    this.mempool.clear();
    logger.debug('Cleared mempool');
  }
  
  async isInMempool(txHash: string): Promise<boolean> {
    this.checkConnection();
    return this.mempool.has(txHash);
  }
  
  // chain metadata
  
  async saveChainMetadata(key: string, value: any): Promise<void> {
    this.checkConnection();
    this.metadata.set(key, value);
  }
  
  async getChainMetadata(key: string): Promise<any> {
    this.checkConnection();
    return this.metadata.get(key) || null;
  }
  
  // custom data storage methods
  private customData: Map<string, string> = new Map();
  private customSets: Map<string, Set<string>> = new Map();
  
  async setCustomData(key: string, value: string, ttl?: number): Promise<void> {
    this.checkConnection();
    this.customData.set(key, value);
    // note: ttl is ignored in memory adapter
  }
  
  async getCustomData(key: string): Promise<string | null> {
    this.checkConnection();
    return this.customData.get(key) || null;
  }
  
  async deleteCustomData(key: string): Promise<void> {
    this.checkConnection();
    this.customData.delete(key);
  }
  
  async addToSet(key: string, value: string): Promise<void> {
    this.checkConnection();
    if (!this.customSets.has(key)) {
      this.customSets.set(key, new Set());
    }
    this.customSets.get(key)!.add(value);
  }
  
  async removeFromSet(key: string, value: string): Promise<void> {
    this.checkConnection();
    const set = this.customSets.get(key);
    if (set) {
      set.delete(value);
    }
  }
  
  async getSetMembers(key: string): Promise<string[]> {
    this.checkConnection();
    const set = this.customSets.get(key);
    return set ? Array.from(set) : [];
  }
}
