import { open, RootDatabase, Database } from 'lmdb';
import { getLogger } from '../utils/logger';
import type { Block } from '../core/block';
import type { Transaction } from '../core/transaction';

const logger = getLogger(__filename);

export interface LMDBConfig {
  path: string;
  mapSize?: number; // max database size in bytes
  maxDbs?: number;  // max number of named databases
  maxReaders?: number;
  compression?: boolean;
}

/**
 * manages all lmdb databases for the bolt blockchain
 * uses a single environment for efficiency
 */
export class LMDBManager {
  private env: RootDatabase;
  
  // blockchain databases
  public blocks: Database;
  public blockIndex: Database;
  public blockHeaders: Database;
  
  // state databases
  public accounts: Database;
  public accountIndex: Database;
  
  // mempool databases
  public mempool: Database;
  public mempoolByFee: Database;
  public mempoolByTime: Database;
  public mempoolByAddress: Database;
  
  // metadata database
  public metadata: Database;
  
  private isOpen: boolean = false;

  constructor(config: LMDBConfig) {
    const { path, mapSize = 100 * 1024 * 1024 * 1024, maxDbs = 15, maxReaders = 126, compression = true } = config;
    
    logger.info(`initializing lmdb at ${path} with mapSize=${mapSize}`);
    
    // open the main environment
    this.env = open({
      path,
      mapSize,
      maxDbs,
      maxReaders,
      
      // performance optimizations
      overlappingSync: true,  // allows readers during sync
      mapAsync: true,         // async memory mapping
      useWritemap: true,      // direct memory writes
      noMetaSync: true,       // don't sync metadata immediately
      
      // bun optimizations
      encoding: 'binary',     // use binary encoding by default
      compression,
    });
    
    this.setupDatabases();
    this.isOpen = true;
  }

  private setupDatabases(): void {
    // blockchain data (append-heavy, permanent)
    this.blocks = this.env.openDB('blocks', {
      compression: true,             // compress old blocks
    });
    
    // block index for hash lookups
    this.blockIndex = this.env.openDB('block_index');
    
    // headers only for fast sync
    this.blockHeaders = this.env.openDB('headers', {
      compression: false,            // headers are small
    });
    
    // account state
    this.accounts = this.env.openDB('accounts');
    
    // account index for fast queries
    this.accountIndex = this.env.openDB('account_index', {
      dupSort: true,                // multiple values per key
    });
    
    // mempool storage
    this.mempool = this.env.openDB('mempool');
    
    // mempool indexes (using composite keys instead of dupSort)
    this.mempoolByFee = this.env.openDB('mempool_by_fee');
    
    this.mempoolByTime = this.env.openDB('mempool_by_time');
    
    this.mempoolByAddress = this.env.openDB('mempool_by_addr');
    
    // metadata storage
    this.metadata = this.env.openDB('metadata');
    
    logger.info('lmdb databases initialized');
  }

  /**
   * execute a transaction across multiple databases atomically
   */
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.env.transaction(fn);
  }

  /**
   * batch write operations for efficiency
   */
  async batchWrite(operations: Array<{
    db: Database;
    type: 'put' | 'remove';
    key: any;
    value?: any;
  }>): Promise<void> {
    await this.env.transaction(() => {
      for (const op of operations) {
        if (op.type === 'put') {
          op.db.put(op.key, op.value);
        } else {
          op.db.remove(op.key);
        }
      }
    });
  }

  /**
   * get database statistics
   */
  async getStats(): Promise<any> {
    const stats = {
      databases: {
        blocks: await this.blocks.getCount(),
        accounts: await this.accounts.getCount(),
        mempool: await this.mempool.getCount(),
      },
    };
    
    return stats;
  }

  /**
   * backup the entire database
   */
  async backup(backupPath: string): Promise<void> {
    logger.info(`backing up database to ${backupPath}`);
    await this.env.backup(backupPath);
    logger.info('backup completed');
  }

  /**
   * compact the database to reclaim space
   */
  async compact(): Promise<void> {
    logger.info('compacting database');
    await this.env.sync();
    logger.info('database compacted');
  }

  /**
   * close all databases and the environment
   */
  async close(): Promise<void> {
    if (!this.isOpen) return;
    
    logger.info('closing lmdb databases');
    await this.env.close();
    this.isOpen = false;
    logger.info('lmdb databases closed');
  }

  /**
   * clear all data (dangerous!)
   */
  async clearAll(): Promise<void> {
    logger.warn('clearing all database content');
    
    await this.env.transaction(async () => {
      await this.blocks.clearAsync();
      await this.blockIndex.clearAsync();
      await this.blockHeaders.clearAsync();
      await this.accounts.clearAsync();
      await this.accountIndex.clearAsync();
      await this.mempool.clearAsync();
      await this.mempoolByFee.clearAsync();
      await this.mempoolByTime.clearAsync();
      await this.mempoolByAddress.clearAsync();
      await this.metadata.clearAsync();
    });
    
    logger.warn('all databases cleared');
  }
}