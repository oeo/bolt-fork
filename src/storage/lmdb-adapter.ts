import { StorageAdapter } from './adapter';
import { LMDBManager } from './lmdb-manager';
import { LMDBBlockchainStore } from './lmdb-blockchain-store';
import { LMDBStateStore } from './lmdb-state-store';
import { LMDBMempoolStore } from './lmdb-mempool-store';
import { Block } from '../core/block';
import { Transaction } from '../core/transaction';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

/**
 * composite lmdb adapter that implements the full StorageAdapter interface
 * delegates to specialized stores for different data types
 */
export class LMDBAdapter implements StorageAdapter {
  private manager: LMDBManager;
  private blockchainStore: LMDBBlockchainStore;
  private stateStore: LMDBStateStore;
  private mempoolStore: LMDBMempoolStore;
  private isConnected = false;

  constructor(config: { path: string; mapSize?: number }) {
    this.manager = new LMDBManager(config);
    this.blockchainStore = new LMDBBlockchainStore(this.manager);
    this.stateStore = new LMDBStateStore(this.manager);
    this.mempoolStore = new LMDBMempoolStore(this.manager);
  }

  async connect(): Promise<void> {
    // lmdb manager opens databases in constructor
    this.isConnected = true;
    logger.info('lmdb storage connected');
  }

  async close(): Promise<void> {
    await this.manager.close();
    this.isConnected = false;
  }

  // blockchain operations
  async addBlock(block: Block): Promise<void> {
    return this.blockchainStore.addBlock(block);
  }

  async saveBlock(block: Block): Promise<void> {
    return this.blockchainStore.addBlock(block);
  }

  async getBlock(index: number): Promise<Block | null> {
    return this.blockchainStore.getBlock(index);
  }

  async getBlockByHash(hash: string): Promise<Block | null> {
    return this.blockchainStore.getBlockByHash(hash);
  }

  async getLatestBlock(): Promise<Block | null> {
    return this.blockchainStore.getLatestBlock();
  }

  async getBlockHeight(): Promise<number> {
    return this.blockchainStore.getBlockHeight();
  }

  async hasBlock(index: number): Promise<boolean> {
    return this.blockchainStore.hasBlock(index);
  }

  async getBlocks(startIndex: number, count: number): Promise<Block[]> {
    return this.blockchainStore.getBlocks(startIndex, count);
  }

  async getCumulativeDifficulty(): Promise<bigint> {
    const metadata = await this.manager.metadata.get('cumulativeDifficulty');
    return metadata ? BigInt(metadata) : 0n;
  }

  async updateCumulativeDifficulty(difficulty: bigint): Promise<void> {
    await this.manager.metadata.put('cumulativeDifficulty', difficulty.toString());
  }

  async getChainTip(): Promise<string | null> {
    const latest = await this.getLatestBlock();
    return latest ? latest.hash : null;
  }

  // state operations
  async getBalance(address: string): Promise<bigint> {
    return this.stateStore.getBalance(address);
  }

  async setBalance(address: string, balance: bigint): Promise<void> {
    return this.stateStore.setBalance(address, balance);
  }

  async getNonce(address: string): Promise<number> {
    return this.stateStore.getNonce(address);
  }

  async setNonce(address: string, nonce: number): Promise<void> {
    return this.stateStore.setNonce(address, nonce);
  }

  async getAccountState(address: string): Promise<any> {
    return this.stateStore.getAccountState(address);
  }

  async setAccountState(address: string, state: any): Promise<void> {
    return this.stateStore.setAccountState(address, state);
  }

  async updateAccountState(address: string, state: any): Promise<void> {
    return this.stateStore.updateAccountState(address, state);
  }

  async getAllBalances(): Promise<Map<string, bigint>> {
    return this.stateStore.getAllBalances();
  }

  // mempool operations
  async addTransaction(tx: Transaction): Promise<void> {
    return this.mempoolStore.addTransaction(tx);
  }

  async getTransaction(hash: string): Promise<Transaction | null> {
    return this.mempoolStore.getTransaction(hash);
  }

  async getTransactions(limit?: number): Promise<Transaction[]> {
    return this.mempoolStore.getTransactions(limit);
  }

  async removeTransaction(hash: string): Promise<void> {
    return this.mempoolStore.removeTransaction(hash);
  }

  async hasTransaction(hash: string): Promise<boolean> {
    return this.mempoolStore.hasTransaction(hash);
  }

  async clearMempool(): Promise<void> {
    return this.mempoolStore.clearMempool();
  }

  async getMempoolSize(): Promise<number> {
    return this.mempoolStore.getMempoolSize();
  }

  async getTransactionsByAddress(address: string): Promise<Transaction[]> {
    return this.mempoolStore.getTransactionsByAddress(address);
  }

  // transaction persistence (for blockchain)
  async saveTransaction(tx: any): Promise<void> {
    // transactions are saved as part of blocks
    // this is a no-op for now
  }

  // utility operations
  async getStats(): Promise<any> {
    return this.manager.getStats();
  }

  async getStorageStats(): Promise<any> {
    const stats = await this.manager.getStats();
    return {
      type: 'lmdb',
      databases: stats.databases,
      used: 0, // lmdb doesn't easily report size in bytes
      keys: (stats.databases?.blocks || 0) + (stats.databases?.accounts || 0) + (stats.databases?.mempool || 0),
      connected: this.isConnected
    };
  }
}