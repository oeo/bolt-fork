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

export const DEFAULT_MEMPOOL_LIMITS = {
  maxSize: 10000,
  maxSizeBytes: 100_000_000,
  maxTransactionSize: 100_000,
} as const;

export function selectMempoolLimitRemovals(
  entries: MempoolEntry[],
  maxSize: number,
  maxSizeBytes: number,
  protectedSenders: ReadonlySet<string> = new Set(),
  maximumEvictionFee?: bigint
): string[] {
  let count = entries.length;
  let bytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (count <= maxSize && bytes <= maxSizeBytes) return [];

  const candidates = entries
    .filter(entry => !protectedSenders.has(entry.transaction.from ?? ''))
    .sort((a, b) => {
      const feeDifference = a.feePerByte - b.feePerByte;
      if (feeDifference < 0n) return -1;
      if (feeDifference > 0n) return 1;
      if (a.transaction.from === b.transaction.from) return b.transaction.nonce - a.transaction.nonce;
      if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
      return a.transaction.hash.localeCompare(b.transaction.hash);
    });
  const removed = new Set<string>();
    for (const entry of candidates) {
    if (count <= maxSize && bytes <= maxSizeBytes) break;
    if (removed.has(entry.transaction.hash)) continue;
    const dependents = entries.filter(dependent =>
      dependent.transaction.from === entry.transaction.from &&
      dependent.transaction.nonce >= entry.transaction.nonce &&
      !removed.has(dependent.transaction.hash)
    );
    if (
      maximumEvictionFee !== undefined &&
      dependents.some(dependent => dependent.feePerByte >= maximumEvictionFee)
    ) {
      continue;
    }
    for (const dependent of dependents) {
      removed.add(dependent.transaction.hash);
      count--;
      bytes -= dependent.size;
    }
  }
  if (count > maxSize || bytes > maxSizeBytes) throw new Error('Mempool size limit reached');
  return [...removed];
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
      maxSize: config.maxSize || DEFAULT_MEMPOOL_LIMITS.maxSize,
      maxSizeBytes: config.maxSizeBytes || DEFAULT_MEMPOOL_LIMITS.maxSizeBytes,
      minFeePerByte: config.minFeePerByte || chainConfig.minFeePerByte,
      maxTransactionAge: config.maxTransactionAge || 72 * 60 * 60 * 1000, // 72 hours
      maxTransactionSize: config.maxTransactionSize || DEFAULT_MEMPOOL_LIMITS.maxTransactionSize,
    };
    this.entries = new Map();
    this.totalBytes = 0;
    this.storage.setMempoolPolicy({
      maxSize: this.config.maxSize!,
      maxSizeBytes: this.config.maxSizeBytes!,
      maxTransactionSize: this.config.maxTransactionSize!,
      minFeePerByte: this.config.minFeePerByte!,
    });
    this.storage.onCanonicalMempoolUpdate((additions, removals) => {
      for (const hash of removals) this.removeEntry(hash);
      for (const { transaction, addedAt } of additions) {
        this.removeEntry(transaction.hash);
        const size = TransactionClass.fromObject(transaction).getSize();
        this.entries.set(transaction.hash, {
          transaction,
          addedAt,
          size,
          feePerByte: transaction.fee / BigInt(size),
        });
        this.totalBytes += size;
      }
    });
  }
  
  /**
   * initialize mempool from storage
   */
  async initialize(): Promise<void> {
    try {
      await this.storage.withStateWrite(async () => {
        const stored = await this.storage.getMempoolEntries();
        const removals = new Set<string>();
        const bySender = new Map<string, typeof stored>();
        const restored: MempoolEntry[] = [];
        const expiredNonceBySender = new Map<string, number>();
        this.entries.clear();
        this.totalBytes = 0;

        for (const entry of stored) {
          const sender = entry.transaction.from;
          if (!sender) throw new Error(`Invalid stored transaction ${entry.transaction.hash}: Coinbase transaction`);
          if (Date.now() - entry.addedAt > this.config.maxTransactionAge!) {
            const expiredNonce = expiredNonceBySender.get(sender);
            expiredNonceBySender.set(sender, Math.min(expiredNonce ?? entry.transaction.nonce, entry.transaction.nonce));
          }
        }
        for (const entry of stored) {
          const sender = entry.transaction.from!;
          if (entry.transaction.nonce >= (expiredNonceBySender.get(sender) ?? Number.POSITIVE_INFINITY)) {
            removals.add(entry.transaction.hash);
            continue;
          }
          const queue = bySender.get(sender) ?? [];
          queue.push(entry);
          bySender.set(sender, queue);
        }

        for (const [sender, queue] of bySender) {
          queue.sort((a, b) =>
            a.transaction.nonce - b.transaction.nonce ||
            a.addedAt - b.addedAt ||
            a.transaction.hash.localeCompare(b.transaction.hash)
          );
          const admission = await this.storage.getMempoolAdmissionState(sender);
          let balance = admission.accountState?.balance ?? 0n;
          let nonce = admission.accountState?.nonce ?? 0;
          for (let index = 0; index < queue.length; index++) {
            const entry = queue[index];
            const transaction = TransactionClass.fromObject(entry.transaction);
            const validation = transaction.validate(this.config.chainId!, this.config.addressPrefix!);
            if (!validation.valid) {
              throw new Error(`Invalid stored transaction ${transaction.hash}: ${validation.error}`);
            }
            if (!await transaction.verify()) {
              throw new Error(`Invalid stored transaction ${transaction.hash}: Invalid signature`);
            }
            const account = transaction.validateAgainstAccount(balance, nonce);
            if (!account.valid) throw new Error(`Invalid stored transaction ${transaction.hash}: ${account.error}`);
            const size = transaction.getSize();
            const feePerByte = transaction.fee / BigInt(size);
            if (size > this.config.maxTransactionSize! || feePerByte < this.config.minFeePerByte!) {
              for (const removed of queue.slice(index)) removals.add(removed.transaction.hash);
              break;
            }
            balance -= transaction.amount + transaction.fee;
            nonce++;
            restored.push({ transaction: entry.transaction, addedAt: entry.addedAt, size, feePerByte });
          }
        }

        for (const hash of selectMempoolLimitRemovals(
          restored,
          this.config.maxSize!,
          this.config.maxSizeBytes!
        )) removals.add(hash);
        if (removals.size > 0) {
          const admission = await this.storage.getMempoolAdmissionState('');
          await this.storage.updateMempool({
            expectedTip: admission.tip,
            additions: [],
            removals: [...removals],
          });
        }
        for (const entry of restored) {
          if (removals.has(entry.transaction.hash)) continue;
          this.entries.set(entry.transaction.hash, entry);
          this.totalBytes += entry.size;
        }
      });
      
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
    return this.withWriteLock(() => this.storage.withStateWrite(() => this.addTransactionUnlocked(tx)));
  }

  private async addTransactionUnlocked(tx: Transaction | TransactionClass): Promise<void> {
    const transaction = tx instanceof TransactionClass ? tx.toObject() : tx;
    
    // check if already in mempool
    if (this.entries.has(transaction.hash)) {
      throw new Error(`Transaction ${transaction.hash} already in mempool`);
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
    
    let admission;
    if (transaction.from) {
      admission = await this.storage.getMempoolAdmissionState(transaction.from);
      let balance = admission.accountState?.balance ?? 0n;
      let nonce = admission.accountState?.nonce ?? 0;
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
    
    const entry: MempoolEntry = {
      transaction,
      addedAt: Date.now(),
      size,
      feePerByte
    };
    const removals = selectMempoolLimitRemovals(
      [...this.entries.values(), entry],
      this.config.maxSize!,
      this.config.maxSizeBytes!,
      new Set([transaction.from!]),
      feePerByte
    );
    await this.storage.updateMempool({
      expectedTip: admission!.tip,
      additions: [{ transaction, addedAt: entry.addedAt }],
      removals,
    });
    for (const hash of removals) this.removeEntry(hash);
    this.entries.set(transaction.hash, entry);
    this.totalBytes += size;
    
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
    return this.withWriteLock(async () => {
      await this.storage.withStateWrite(async () => {
        const entry = this.entries.get(txHash);
        if (!entry) return;
        const removals = Array.from(this.entries.values())
          .filter(candidate =>
            candidate.transaction.from === entry.transaction.from &&
            candidate.transaction.nonce >= entry.transaction.nonce
          )
          .map(candidate => candidate.transaction.hash);
        const admission = await this.storage.getMempoolAdmissionState(entry.transaction.from ?? '');
        await this.storage.updateMempool({
          expectedTip: admission.tip,
          additions: [],
          removals,
        });
        for (const hash of removals) this.removeEntry(hash);
        logger.debug(`Removed ${removals.length} transactions from mempool`);
      });
    });
  }
  
  /**
   * get transactions for block inclusion, sorted by fee
   */
  getTransactionsForBlock(maxSize: number = chainConfig.maxBlockSize): Transaction[] {
    this.removeExpiredTransactions();
    const queues = new Map<string, MempoolEntry[]>();
    const expiredNonceBySender = new Map<string, number>();
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (now - entry.addedAt <= this.config.maxTransactionAge!) continue;
      const sender = entry.transaction.from!;
      const nonce = expiredNonceBySender.get(sender);
      expiredNonceBySender.set(sender, Math.min(nonce ?? entry.transaction.nonce, entry.transaction.nonce));
    }
    for (const entry of this.entries.values()) {
      const sender = entry.transaction.from!;
      if (entry.transaction.nonce >= (expiredNonceBySender.get(sender) ?? Number.POSITIVE_INFINITY)) continue;
      const queue = queues.get(sender) ?? [];
      queue.push(entry);
      queues.set(sender, queue);
    }
    for (const queue of queues.values()) {
      queue.sort((a, b) => a.transaction.nonce - b.transaction.nonce);
    }

    const transactions: Transaction[] = [];
    let currentSize = 0;
    while (queues.size > 0) {
      const [entry] = Array.from(queues.values(), queue => queue[0]).sort((a, b) => {
        const feeDifference = b.feePerByte - a.feePerByte;
        if (feeDifference > 0n) return 1;
        if (feeDifference < 0n) return -1;
        if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
        return a.transaction.hash.localeCompare(b.transaction.hash);
      });
      const sender = entry.transaction.from!;
      if (currentSize + entry.size > maxSize) {
        queues.delete(sender);
        continue;
      }
      transactions.push(entry.transaction);
      currentSize += entry.size;
      const queue = queues.get(sender)!;
      queue.shift();
      if (queue.length === 0) queues.delete(sender);
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
    await this.withWriteLock(() => this.storage.withStateWrite(async () => {
      await this.storage.clearMempool();
      this.entries.clear();
      this.totalBytes = 0;
    }));
    
    logger.info('Mempool cleared');
  }
  
  /**
   * remove transactions that are in a block
   */
  async removeBlockTransactions(transactions: Transaction[]): Promise<void> {
    await this.withWriteLock(() => this.storage.withStateWrite(async () => {
      const removals = transactions
        .map(transaction => transaction.hash)
        .filter(hash => this.entries.has(hash));
      if (removals.length === 0) return;
      const admission = await this.storage.getMempoolAdmissionState('');
      await this.storage.updateMempool({
        expectedTip: admission.tip,
        additions: [],
        removals,
      });
      for (const hash of removals) this.removeEntry(hash);
    }));
  }
  
  /**
   * validate all transactions in mempool against current state
   * removes invalid transactions
   */
  async validateAgainstState(
    getBalance: (address: string) => Promise<bigint>,
    getNonce: (address: string) => Promise<number>
  ): Promise<void> {
    await this.withWriteLock(() => this.storage.withStateWrite(async () => {
      const bySender = new Map<string, MempoolEntry[]>();
      for (const entry of this.entries.values()) {
        const sender = entry.transaction.from;
        if (!sender) continue;
        const queue = bySender.get(sender) ?? [];
        queue.push(entry);
        bySender.set(sender, queue);
      }

      const toRemove = new Set<string>();
      for (const [sender, queue] of bySender) {
        queue.sort((a, b) => a.transaction.nonce - b.transaction.nonce);
        try {
          let balance = await getBalance(sender);
          let nonce = await getNonce(sender);
          for (let index = 0; index < queue.length; index++) {
            const entry = queue[index];
            const tx = TransactionClass.fromObject(entry.transaction);
            const validation = tx.validateAgainstAccount(balance, nonce);
            if (!validation.valid) {
              logger.debug(`Removing invalid transaction ${tx.hash}: ${validation.error}`);
              for (const removed of queue.slice(index)) toRemove.add(removed.transaction.hash);
              break;
            }
            balance -= tx.amount + tx.fee;
            nonce++;
          }
        } catch (error) {
          logger.error(`Error validating transactions from ${sender}`, error);
          for (const entry of queue) toRemove.add(entry.transaction.hash);
        }
      }

      if (toRemove.size > 0) {
        const admission = await this.storage.getMempoolAdmissionState('');
        await this.storage.updateMempool({
          expectedTip: admission.tip,
          additions: [],
          removals: [...toRemove],
        });
        for (const hash of toRemove) this.removeEntry(hash);
        logger.info(`Removed ${toRemove.size} invalid transactions from mempool`);
      }
    }));
  }
  
  private removeExpiredTransactions(): void {
    const now = Date.now();
    if (![...this.entries.values()].some(entry => now - entry.addedAt > this.config.maxTransactionAge!)) return;
    void this.withWriteLock(async () => {
      await this.storage.withStateWrite(async () => {
        const expiredNonceBySender = new Map<string, number>();
        const lockedNow = Date.now();
        for (const entry of this.entries.values()) {
          if (lockedNow - entry.addedAt <= this.config.maxTransactionAge!) continue;
          const sender = entry.transaction.from!;
          const nonce = expiredNonceBySender.get(sender);
          expiredNonceBySender.set(sender, Math.min(nonce ?? entry.transaction.nonce, entry.transaction.nonce));
        }
        const removals = Array.from(this.entries.entries())
          .filter(([, entry]) =>
            entry.transaction.nonce >= (
              expiredNonceBySender.get(entry.transaction.from!) ?? Number.POSITIVE_INFINITY
            )
          )
          .map(([hash]) => hash);
        if (removals.length === 0) return;
        const admission = await this.storage.getMempoolAdmissionState('');
        await this.storage.updateMempool({ expectedTip: admission.tip, additions: [], removals });
        for (const hash of removals) this.removeEntry(hash);
      });
    }).catch(error => logger.error('Failed to remove expired transactions', error));
  }

  private removeEntry(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) return;
    this.entries.delete(hash);
    this.totalBytes -= entry.size;
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
