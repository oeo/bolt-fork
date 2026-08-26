import { LMDBManager } from './lmdb-manager';
import type { Transaction } from '../types';
import { getLogger } from '../utils/logger';
import { serializeBigInt, deserializeBigInt } from '../utils/serialization';
import type { PersistedMempoolEntry } from './adapter';

const logger = getLogger(__filename);

interface MempoolStats {
  count: number;
  bytes: number;
  minFee: bigint;
  maxFee: bigint;
  avgFee: bigint;
}

/**
 * lmdb-backed mempool storage
 * handles unconfirmed transactions with multiple indexes
 */
export class LMDBMempoolStore {
  private lmdb: LMDBManager;

  constructor(lmdb: LMDBManager) {
    this.lmdb = lmdb;
  }

  /**
   * add a transaction to the mempool
   */
  async addTransaction(tx: Transaction): Promise<boolean> {
    // check if already exists
    const exists = await this.lmdb.mempool.get(tx.hash);
    if (exists) {
      logger.debug(`transaction ${tx.hash} already in mempool`);
      return false;
    }
    
    this.lmdb.transactionSync(() => {
      this.writeUpdate([{ transaction: tx, addedAt: Date.now() }], []);
    });
    
    logger.debug(`added transaction ${tx.hash} to mempool`);
    return true;
  }

  /**
   * remove a transaction from the mempool
   */
  async removeTransaction(txHash: string): Promise<void> {
    const txData = await this.lmdb.mempool.get(txHash);
    if (!txData) return;
    
    this.lmdb.transactionSync(() => {
      this.writeUpdate([], [txHash]);
    });
    
    logger.debug(`removed transaction ${txHash} from mempool`);
  }

  /**
   * remove multiple transactions (after block inclusion)
   */
  async removeTransactions(txHashes: string[]): Promise<void> {
    if (txHashes.length === 0) return;
    
    this.lmdb.transactionSync(() => this.writeUpdate([], txHashes));
    
    logger.debug(`removed ${txHashes.length} transactions from mempool`);
  }

  /**
   * get a transaction from the mempool
   */
  async getTransaction(txHash: string): Promise<Transaction | null> {
    const data = await this.lmdb.mempool.get(txHash);
    if (!data) return null;
    
    return this.deserializeEntry(data).transaction;
  }

  /**
   * check if a transaction exists in the mempool
   */
  async hasTransaction(txHash: string): Promise<boolean> {
    const exists = await this.lmdb.mempool.get(txHash);
    return exists !== undefined;
  }

  /**
   * get all transactions in the mempool
   */
  async getTransactions(): Promise<Transaction[]> {
    const transactions: Transaction[] = [];
    
    for await (const { value } of this.lmdb.mempool.getRange()) {
      transactions.push(this.deserializeEntry(value).transaction);
    }
    
    return transactions;
  }

  /**
   * get transactions sorted by fee (highest first) for mining
   */
  async getTopTransactionsByFee(limit: number): Promise<Transaction[]> {
    const transactions: Transaction[] = [];
    
    // iterate normally (inverted fees mean lowest inverted = highest actual)
    for await (const { value } of this.lmdb.mempoolByFee.getRange({
      limit,
    })) {
      const txHash = typeof value === 'string' ? value : value.toString();
      const txData = await this.lmdb.mempool.get(txHash);
      if (txData) {
        transactions.push(this.deserializeEntry(txData).transaction);
      }
    }
    
    return transactions;
  }

  /**
   * get transactions by address
   */
  async getTransactionsByAddress(address: string): Promise<Transaction[]> {
    const transactions: Transaction[] = [];
    const seen = new Set<string>();
    
    // create start and end keys for range query
    const startKey = `${address}:`;
    const endKey = `${address}:\xff`;
    
    for await (const { value } of this.lmdb.mempoolByAddress.getRange({
      start: startKey,
      end: endKey,
    })) {
      const txHash = typeof value === 'string' ? value : value.toString();
      if (!seen.has(txHash)) {
        seen.add(txHash);
        const txData = await this.lmdb.mempool.get(txHash);
        if (txData) {
          transactions.push(this.deserializeEntry(txData).transaction);
        }
      }
    }
    
    return transactions;
  }

  /**
   * prune old transactions from mempool
   */
  async pruneOldTransactions(maxAgeSeconds: number): Promise<number> {
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    const toRemove: string[] = [];
    
    // find old transactions by iterating time index
    for await (const { key, value } of this.lmdb.mempoolByTime.getRange()) {
      // extract timestamp from composite key
      const timestamp = parseInt(String(key).split(':')[0], 16);
      if (timestamp <= cutoff) {
        const txHash = typeof value === 'string' ? value : value.toString();
        toRemove.push(txHash);
      } else {
        break; // timestamps are sorted, so we can stop
      }
    }
    
    // remove them
    if (toRemove.length > 0) {
      await this.removeTransactions(toRemove);
    }
    
    logger.info(`pruned ${toRemove.length} old transactions from mempool`);
    return toRemove.length;
  }

  /**
   * clear all transactions from mempool
   */
  async clear(): Promise<void> {
    this.lmdb.transactionSync(() => {
      this.lmdb.mempool.clearSync();
      this.lmdb.mempoolByFee.clearSync();
      this.lmdb.mempoolByTime.clearSync();
      this.lmdb.mempoolByAddress.clearSync();
    });
    
    logger.info('mempool cleared');
  }

  /**
   * get mempool statistics
   */
  async getStats(): Promise<MempoolStats> {
    const count = await this.lmdb.mempool.getCount();
    
    if (count === 0) {
      return {
        count: 0,
        bytes: 0,
        minFee: 0n,
        maxFee: 0n,
        avgFee: 0n,
      };
    }
    
    let minFee = BigInt(Number.MAX_SAFE_INTEGER);
    let maxFee = 0n;
    let totalFees = 0n;
    let totalBytes = 0;
    
    for await (const { value } of this.lmdb.mempool.getRange()) {
      const tx = this.deserializeEntry(value).transaction;
      
      if (tx.fee < minFee) minFee = tx.fee;
      if (tx.fee > maxFee) maxFee = tx.fee;
      totalFees += tx.fee;
      totalBytes += value.length;
    }
    
    return {
      count,
      bytes: totalBytes,
      minFee,
      maxFee,
      avgFee: totalFees / BigInt(count),
    };
  }

  // helper methods
  
  private createTimeKey(timestamp: number, txHash: string): string {
    const timestampHex = timestamp.toString(16).padStart(12, '0');
    return `${timestampHex}:${txHash}`;
  }

  private createAddressKey(address: string, txHash: string): string {
    // create composite key: address + hash
    return `${address}:${txHash}`;
  }
  
  private createFeeKey(fee: bigint, txHash: string): string {
    // create composite key: inverted fee + hash
    // inverting fee makes natural ascending sort give us highest fees first
    const MAX_FEE = BigInt('0xFFFFFFFFFFFFFFFF');
    const invertedFee = MAX_FEE - fee;
    const feeHex = invertedFee.toString(16).padStart(16, '0');
    return `${feeHex}:${txHash}`;
  }

  getEntries(): PersistedMempoolEntry[] {
    const entries: PersistedMempoolEntry[] = [];
    for (const { value } of this.lmdb.mempool.getRange()) {
      entries.push(this.deserializeEntry(value));
    }
    return entries;
  }

  readEntry(hash: string): PersistedMempoolEntry | null {
    const data = this.lmdb.mempool.get(hash);
    return data ? this.deserializeEntry(data) : null;
  }

  writeUpdate(additions: PersistedMempoolEntry[], removals: string[]): void {
    for (const hash of removals) {
      const data = this.lmdb.mempool.get(hash);
      if (!data) continue;
      const entry = this.deserializeEntry(data);
      const tx = entry.transaction;
      this.lmdb.mempool.removeSync(hash);
      this.lmdb.mempoolByFee.removeSync(this.createFeeKey(tx.fee, hash));
      this.lmdb.mempoolByTime.removeSync(this.createTimeKey(entry.addedAt, hash));
      if (tx.from) this.lmdb.mempoolByAddress.removeSync(this.createAddressKey(tx.from, hash));
      this.lmdb.mempoolByAddress.removeSync(this.createAddressKey(tx.to, hash));
    }
    for (const entry of additions) {
      const tx = entry.transaction;
      this.lmdb.mempool.putSync(tx.hash, this.serializeEntry(entry));
      this.lmdb.mempoolByFee.putSync(this.createFeeKey(tx.fee, tx.hash), tx.hash);
      this.lmdb.mempoolByTime.putSync(this.createTimeKey(entry.addedAt, tx.hash), tx.hash);
      if (tx.from) this.lmdb.mempoolByAddress.putSync(this.createAddressKey(tx.from, tx.hash), tx.hash);
      this.lmdb.mempoolByAddress.putSync(this.createAddressKey(tx.to, tx.hash), tx.hash);
    }
  }

  private serializeEntry(entry: PersistedMempoolEntry): Buffer {
    const json = JSON.stringify({
      addedAt: entry.addedAt,
      transaction: {
        ...entry.transaction,
        amount: serializeBigInt(entry.transaction.amount),
        fee: serializeBigInt(entry.transaction.fee),
      },
    });
    return Buffer.from(json);
  }

  private deserializeEntry(data: Buffer): PersistedMempoolEntry {
    const json = JSON.parse(data.toString());
    return {
      addedAt: json.addedAt,
      transaction: {
        ...json.transaction,
        amount: deserializeBigInt(json.transaction.amount),
        fee: deserializeBigInt(json.transaction.fee),
      },
    };
  }
}
