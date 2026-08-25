import { LMDBManager } from './lmdb-manager';
import type { Transaction } from '../types';
import { getLogger } from '../utils/logger';
import { serializeBigInt, deserializeBigInt } from '../utils/serialization';

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
    
    const serialized = this.serializeTransaction(tx);
    const timestamp = Math.floor(Date.now() / 1000);
    
    await this.lmdb.transaction(() => {
      // add to main storage
      this.lmdb.mempool.put(tx.hash, serialized);
      
      // add to fee index with composite key
      const feeKey = this.createFeeKey(tx.fee, tx.hash);
      this.lmdb.mempoolByFee.put(feeKey, tx.hash);
      
      // add to time index with composite key
      const timeKey = this.createTimeKey(timestamp, tx.hash);
      this.lmdb.mempoolByTime.put(timeKey, tx.hash);
      
      // add to address indexes with composite keys
      if (tx.from) {
        const fromKey = this.createAddressKey(tx.from, tx.hash);
        this.lmdb.mempoolByAddress.put(fromKey, tx.hash);
      }
      if (tx.to) {
        const toKey = this.createAddressKey(tx.to, tx.hash);
        this.lmdb.mempoolByAddress.put(toKey, tx.hash);
      }
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
    
    const tx = this.deserializeTransaction(txData);
    
    await this.lmdb.transaction(async () => {
      // remove from main storage
      await this.lmdb.mempool.remove(txHash);
      
      // remove from fee index
      const feeKey = this.createFeeKey(tx.fee, txHash);
      await this.lmdb.mempoolByFee.remove(feeKey);
      
      // remove from time index (need to search for timestamp)
      for await (const { key, value } of this.lmdb.mempoolByTime.getRange()) {
        if (value === txHash) {
          await this.lmdb.mempoolByTime.remove(key);
          break;
        }
      }
      
      // remove from address indexes
      if (tx.from) {
        const fromKey = this.createAddressKey(tx.from, txHash);
        await this.lmdb.mempoolByAddress.remove(fromKey);
      }
      if (tx.to) {
        const toKey = this.createAddressKey(tx.to, txHash);
        await this.lmdb.mempoolByAddress.remove(toKey);
      }
    });
    
    logger.debug(`removed transaction ${txHash} from mempool`);
  }

  /**
   * remove multiple transactions (after block inclusion)
   */
  async removeTransactions(txHashes: string[]): Promise<void> {
    if (txHashes.length === 0) return;
    
    await this.lmdb.transaction(async () => {
      for (const hash of txHashes) {
        const txData = await this.lmdb.mempool.get(hash);
        if (!txData) continue;
        
        const tx = this.deserializeTransaction(txData);
        
        // remove from all indexes
        await this.lmdb.mempool.remove(hash);
        
        const feeKey = this.createFeeKey(tx.fee, hash);
        await this.lmdb.mempoolByFee.remove(feeKey);
        
        if (tx.from) {
          const fromKey = this.createAddressKey(tx.from, hash);
          await this.lmdb.mempoolByAddress.remove(fromKey);
        }
        if (tx.to) {
          const toKey = this.createAddressKey(tx.to, hash);
          await this.lmdb.mempoolByAddress.remove(toKey);
        }
      }
    });
    
    logger.debug(`removed ${txHashes.length} transactions from mempool`);
  }

  /**
   * get a transaction from the mempool
   */
  async getTransaction(txHash: string): Promise<Transaction | null> {
    const data = await this.lmdb.mempool.get(txHash);
    if (!data) return null;
    
    return this.deserializeTransaction(data);
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
      transactions.push(this.deserializeTransaction(value));
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
        transactions.push(this.deserializeTransaction(txData));
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
          transactions.push(this.deserializeTransaction(txData));
        }
      }
    }
    
    return transactions;
  }

  /**
   * prune old transactions from mempool
   */
  async pruneOldTransactions(maxAgeSeconds: number): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    const toRemove: string[] = [];
    
    // find old transactions by iterating time index
    for await (const { key, value } of this.lmdb.mempoolByTime.getRange()) {
      // extract timestamp from composite key
      const timestampHex = String(key).split(':')[0];
      const timestamp = parseInt(timestampHex, 16);
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
    await this.lmdb.transaction(async () => {
      await this.lmdb.mempool.clearAsync();
      await this.lmdb.mempoolByFee.clearAsync();
      await this.lmdb.mempoolByTime.clearAsync();
      await this.lmdb.mempoolByAddress.clearAsync();
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
      const tx = this.deserializeTransaction(value);
      
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
    // create composite key: timestamp padded + hash
    const timestampHex = timestamp.toString(16).padStart(8, '0');
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

  private serializeTransaction(tx: Transaction): Buffer {
    const json = JSON.stringify({
      ...tx,
      amount: serializeBigInt(tx.amount),
      fee: serializeBigInt(tx.fee),
    });
    return Buffer.from(json);
  }

  private deserializeTransaction(data: Buffer): Transaction {
    const json = JSON.parse(data.toString());
    return {
      ...json,
      amount: deserializeBigInt(json.amount),
      fee: deserializeBigInt(json.fee),
    };
  }
}
