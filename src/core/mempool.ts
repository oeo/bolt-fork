import { EventEmitter } from 'events';
import { Transaction } from '../types';
import { StorageAdapter } from '../storage/adapter';
import { TransactionClass } from './transaction';
import { getLogger } from '../utils/logger';
import { config as chainConfig } from '../config/chain';
import { formatWatts } from '../utils/currency';

const logger = getLogger(__filename);

export interface MempoolConfig {
  chainId?: number;
  addressPrefix?: number;
  maxSize?: number;           // max number of transactions
  maxSizeBytes?: number;      // max total size in bytes
  minFeePerByte?: bigint;     // minimum fee per byte in watts
  maxTransactionAge?: number; // max age in milliseconds
  maxTransactionSize?: number;// max individual tx size in bytes
}

export interface MempoolEntry {
  transaction: Transaction;
  addedAt: number;      // timestamp when added
  size: number;         // size in bytes
  feePerByte: bigint;   // fee per byte in watts
}

export interface MempoolStats {
  size: number;         // number of transactions
  bytes: number;        // total size in bytes
  totalFees: bigint;    // total fees in watts
  minFeePerByte: bigint;
  maxFeePerByte: bigint;
  avgFeePerByte: bigint;
}

/**
 * mempool manages pending transactions waiting for block inclusion
 */
export class Mempool extends EventEmitter {
  private storage: StorageAdapter;
  private config: MempoolConfig;
  private entries: Map<string, MempoolEntry>;
  private totalBytes: number;
  private writeTail: Promise<void> = Promise.resolve();
  
  constructor(storage: StorageAdapter, config: MempoolConfig = {}) {
    super();
    this.storage = storage;
    this.config = {
      chainId: config.chainId ?? chainConfig.chainId,
      addressPrefix: config.addressPrefix ?? chainConfig.addressPrefix,
      maxSize: config.maxSize || 10000,
      maxSizeBytes: config.maxSizeBytes || 100_000_000, // 100MB
      minFeePerByte: config.minFeePerByte || chainConfig.minFeePerByte,
      maxTransactionAge: config.maxTransactionAge || 72 * 60 * 60 * 1000, // 72 hours
      maxTransactionSize: config.maxTransactionSize || 100_000, // 100KB default
    };
    this.entries = new Map();
    this.totalBytes = 0;
  }
  
  /**
   * initialize mempool from storage
   */
  async initialize(): Promise<void> {
    try {
      const transactions = await this.storage.getMempoolTransactions();
      
      for (const tx of transactions) {
        const txClass = TransactionClass.fromObject(tx);
        const validation = txClass.validate(this.config.chainId!, this.config.addressPrefix!);
        if (!validation.valid) {
          throw new Error(`Invalid stored transaction ${tx.hash}: ${validation.error}`);
        }
        const size = txClass.getSize();
        const feePerByte = tx.fee / BigInt(size);
        
        this.entries.set(tx.hash, {
          transaction: tx,
          addedAt: Date.now(),
          size,
          feePerByte
        });
        this.totalBytes += size;
      }
      
      logger.info(`Mempool initialized with ${this.entries.size} transactions`);
    } catch (error) {
      logger.error('Failed to initialize mempool', error);
      throw error;
    }
  }
  
  /**
   * add transaction to mempool
   */
  async addTransaction(tx: Transaction | TransactionClass): Promise<void> {
    return this.withWriteLock(() => this.addTransactionUnlocked(tx));
  }

  private async addTransactionUnlocked(tx: Transaction | TransactionClass): Promise<void> {
    const transaction = tx instanceof TransactionClass ? tx.toObject() : tx;
    
    // check if already in mempool
    if (this.entries.has(transaction.hash)) {
      throw new Error(`Transaction ${transaction.hash} already in mempool`);
    }
    
    // check if already in storage mempool
    const inStorage = await this.storage.isInMempool(transaction.hash);
    if (inStorage) {
      throw new Error(`Transaction ${transaction.hash} already in storage mempool`);
    }
    
    // validate transaction
    const txClass = tx instanceof TransactionClass ? tx : TransactionClass.fromObject(transaction);
    if (txClass.isCoinbase()) {
      throw new Error('Coinbase transactions cannot enter mempool');
    }
    const validation = txClass.validate(this.config.chainId!, this.config.addressPrefix!);
    if (!validation.valid) {
      throw new Error(`Invalid transaction: ${validation.error}`);
    }
    if (!await txClass.verify()) {
      throw new Error('Invalid transaction signature');
    }
    
    if (transaction.from) {
      const canonical = await this.storage.getAccountState(transaction.from);
      let balance = canonical?.balance ?? 0n;
      let nonce = canonical?.nonce ?? 0;
      const senderTxs = (await this.getTransactionsBySender(transaction.from))
        .sort((a, b) => a.nonce - b.nonce);
      for (const pending of senderTxs) {
        if (pending.nonce !== nonce) throw new Error(`Invalid pending nonce ${pending.nonce}`);
        balance -= pending.amount + pending.fee;
        nonce++;
      }
      const accountValidation = txClass.validateAgainstAccount(balance, nonce);
      if (!accountValidation.valid) {
        throw new Error(accountValidation.error);
      }
    }
    
    // check transaction size
    const size = txClass.getSize();
    if (size > this.config.maxTransactionSize!) {
      throw new Error(`Transaction too large: ${size} > ${this.config.maxTransactionSize}`);
    }
    
    // check minimum fee (ensure size is BigInt for division)
    const feePerByte = transaction.fee / BigInt(size);
    if (feePerByte < this.config.minFeePerByte!) {
      throw new Error(`Fee too low: ${formatWatts(feePerByte)}/byte < ${formatWatts(this.config.minFeePerByte!)}/byte`);
    }
    
    // check mempool size limits
    if (this.entries.size >= this.config.maxSize!) {
      // try to evict lower fee transactions
      const evicted = this.evictTransaction();
      if (!evicted || evicted.feePerByte >= feePerByte) {
        throw new Error(`Mempool full and transaction fee too low for inclusion`);
      }
    }
    
    // check mempool byte size limit
    if (this.totalBytes + size > this.config.maxSizeBytes!) {
      // try to evict lower fee transactions
      const evicted = this.evictTransaction();
      if (!evicted) {
        throw new Error(`Mempool size limit reached`);
      }
    }
    
    // add to mempool
    const entry: MempoolEntry = {
      transaction,
      addedAt: Date.now(),
      size,
      feePerByte
    };
    
    this.entries.set(transaction.hash, entry);
    this.totalBytes += size;
    
    // persist to storage
    await this.storage.addToMempool(transaction);
    
    logger.info(`Added transaction ${transaction.hash} to mempool`, {
      size,
      fee: formatWatts(transaction.fee),
      feePerByte: formatWatts(feePerByte)
    });
    
    // emit event for listeners
    this.emit('transactionAdded', transaction);
  }
  
  /**
   * remove transaction from mempool
   */
  async removeTransaction(txHash: string): Promise<void> {
    const entry = this.entries.get(txHash);
    if (!entry) {
      return; // not in mempool
    }
    
    this.entries.delete(txHash);
    this.totalBytes -= entry.size;
    
    // remove from storage
    await this.storage.removeFromMempool(txHash);
    
    logger.debug(`Removed transaction ${txHash} from mempool`);
  }
  
  /**
   * get transactions for block inclusion, sorted by fee
   */
  getTransactionsForBlock(maxSize: number = chainConfig.maxBlockSize): Transaction[] {
    // remove expired transactions first
    this.removeExpiredTransactions();
    
    // sort by fee per byte (highest first), with deterministic tiebreakers
    const sorted = Array.from(this.entries.values())
      .sort((a, b) => {
        // CRITICAL: if same sender, ALWAYS sort by nonce (lower nonce first)
        // This ensures transaction dependencies are respected
        if (a.transaction.from === b.transaction.from && a.transaction.from !== null) {
          return a.transaction.nonce - b.transaction.nonce;
        }
        
        // primary sort: fee per byte (higher is better)
        const diff = b.feePerByte - a.feePerByte;
        if (diff > 0n) return 1;
        if (diff < 0n) return -1;
        
        // secondary sort: first-seen-first-included (older is better)
        if (a.addedAt !== b.addedAt) {
          return a.addedAt - b.addedAt;
        }
        
        // tertiary sort: transaction hash (lexicographic order for determinism)
        return a.transaction.hash.localeCompare(b.transaction.hash);
      });
    
    const transactions: Transaction[] = [];
    let currentSize = 0;
    
    for (const entry of sorted) {
      if (currentSize + entry.size > maxSize) {
        continue; // skip if would exceed block size
      }
      
      transactions.push(entry.transaction);
      currentSize += entry.size;
    }
    
    return transactions;
  }
  
  /**
   * get all transactions in mempool
   */
  getTransactions(): Transaction[] {
    return Array.from(this.entries.values()).map(e => e.transaction);
  }
  
  /**
   * get transaction by hash
   */
  getTransaction(txHash: string): Transaction | null {
    const entry = this.entries.get(txHash);
    return entry ? entry.transaction : null;
  }
  
  /**
   * get all transactions from a specific sender
   */
  async getTransactionsBySender(sender: string): Promise<Transaction[]> {
    const transactions: Transaction[] = [];
    for (const entry of this.entries.values()) {
      if (entry.transaction.from === sender) {
        transactions.push(entry.transaction);
      }
    }
    return transactions;
  }
  
  /**
   * check if transaction exists in mempool
   */
  hasTransaction(txHash: string): boolean {
    return this.entries.has(txHash);
  }
  
  /**
   * get mempool statistics
   */
  getStats(): MempoolStats {
    let totalFees = 0n;
    let minFeePerByte = 0n;
    let maxFeePerByte = 0n;
    
    for (const entry of this.entries.values()) {
      totalFees += entry.transaction.fee;
      
      if (minFeePerByte === 0n || entry.feePerByte < minFeePerByte) {
        minFeePerByte = entry.feePerByte;
      }
      
      if (entry.feePerByte > maxFeePerByte) {
        maxFeePerByte = entry.feePerByte;
      }
    }
    
    const avgFeePerByte = this.entries.size > 0 
      ? totalFees / BigInt(this.totalBytes)
      : 0n;
    
    return {
      size: this.entries.size,
      bytes: this.totalBytes,
      totalFees,
      minFeePerByte,
      maxFeePerByte,
      avgFeePerByte
    };
  }
  
  /**
   * clear all transactions from mempool
   */
  async clear(): Promise<void> {
    this.entries.clear();
    this.totalBytes = 0;
    await this.storage.clearMempool();
    
    logger.info('Mempool cleared');
  }
  
  /**
   * remove transactions that are in a block
   */
  async removeBlockTransactions(transactions: Transaction[]): Promise<void> {
    for (const tx of transactions) {
      await this.removeTransaction(tx.hash);
    }
  }
  
  /**
   * validate all transactions in mempool against current state
   * removes invalid transactions
   */
  async validateAgainstState(
    getBalance: (address: string) => Promise<bigint>,
    getNonce: (address: string) => Promise<number>
  ): Promise<void> {
    const toRemove: string[] = [];
    
    for (const [hash, entry] of this.entries) {
      const tx = entry.transaction;
      
      // skip coinbase transactions
      if (!tx.from) continue;
      
      try {
        const balance = await getBalance(tx.from);
        const nonce = await getNonce(tx.from);
        
        const txClass = TransactionClass.fromObject(tx);
        const validation = txClass.validateAgainstAccount(balance, nonce);
        
        if (!validation.valid) {
          logger.debug(`Removing invalid transaction ${hash}: ${validation.error}`);
          toRemove.push(hash);
        }
      } catch (error) {
        logger.error(`Error validating transaction ${hash}`, error);
        toRemove.push(hash);
      }
    }
    
    // remove invalid transactions
    for (const hash of toRemove) {
      await this.removeTransaction(hash);
    }
    
    if (toRemove.length > 0) {
      logger.info(`Removed ${toRemove.length} invalid transactions from mempool`);
    }
  }
  
  /**
   * remove expired transactions
   */
  private removeExpiredTransactions(): void {
    const now = Date.now();
    const maxAge = this.config.maxTransactionAge!;
    const toRemove: string[] = [];
    
    for (const [hash, entry] of this.entries) {
      if (now - entry.addedAt > maxAge) {
        toRemove.push(hash);
      }
    }
    
    for (const hash of toRemove) {
      this.entries.delete(hash);
      const entry = this.entries.get(hash);
      if (entry) {
        this.totalBytes -= entry.size;
      }
    }
    
    if (toRemove.length > 0) {
      logger.debug(`Removed ${toRemove.length} expired transactions from mempool`);
    }
  }
  
  /**
   * evict lowest fee transaction
   */
  private evictTransaction(): MempoolEntry | null {
    let lowestFeeEntry: MempoolEntry | null = null;
    let lowestFeeHash: string | null = null;
    
    for (const [hash, entry] of this.entries) {
      if (!lowestFeeEntry || entry.feePerByte < lowestFeeEntry.feePerByte) {
        lowestFeeEntry = entry;
        lowestFeeHash = hash;
      }
    }
    
    if (lowestFeeHash && lowestFeeEntry) {
      this.entries.delete(lowestFeeHash);
      this.totalBytes -= lowestFeeEntry.size;
      
      // remove from storage (async, but don't await)
      this.storage.removeFromMempool(lowestFeeHash).catch(err => {
        logger.error(`Failed to remove evicted transaction from storage`, err);
      });
      
      logger.debug(`Evicted transaction ${lowestFeeHash} with fee ${formatWatts(lowestFeeEntry.feePerByte)}/byte`);
      
      return lowestFeeEntry;
    }
    
    return null;
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
