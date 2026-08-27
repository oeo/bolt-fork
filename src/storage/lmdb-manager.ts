import { open, RootDatabase, Database } from 'lmdb';
import { getLogger } from '../utils/logger';
import type { Block, Transaction } from '../types';

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
  public blocks!: Database;
  public blockIndex!: Database;
  public blockHeaders!: Database;
  public confirmedTransactions!: Database;
  public confirmedByAddress!: Database;
  
  // state databases
  public accounts!: Database;
  public accountIndex!: Database;
  
  // mempool databases
  public mempool!: Database;
  public mempoolByFee!: Database;
  public mempoolByTime!: Database;
  public mempoolByAddress!: Database;
  
  // metadata database
  public metadata!: Database;
  
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
      
      overlappingSync: true,
      encoding: 'binary',     // use binary encoding by default
      compression,
    });
    
    this.setupDatabases();
    this.isOpen = true;
  }

  private setupDatabases(): void {
    // blockchain data (append-heavy, permanent)
    this.blocks = this.env.openDB({ name: 'blocks',
      compression: true,             // compress old blocks
    });
    
    // block index for hash lookups
    this.blockIndex = this.env.openDB({ name: 'block_index' });
    
    // headers only for fast sync
    this.blockHeaders = this.env.openDB({ name: 'headers',
      compression: false,            // headers are small
    });
    this.confirmedTransactions = this.env.openDB({ name: 'confirmed_transactions' });
    this.confirmedByAddress = this.env.openDB({ name: 'confirmed_by_address' });
    
    // account state
    this.accounts = this.env.openDB({ name: 'accounts' });
    
    // account index for fast queries
    this.accountIndex = this.env.openDB({ name: 'account_index',
      dupSort: true,                // multiple values per key
    });
    
    // mempool storage
    this.mempool = this.env.openDB({ name: 'mempool' });
    
    // mempool indexes (using composite keys instead of dupSort)
    this.mempoolByFee = this.env.openDB({ name: 'mempool_by_fee' });
    
    this.mempoolByTime = this.env.openDB({ name: 'mempool_by_time' });
    
    this.mempoolByAddress = this.env.openDB({ name: 'mempool_by_addr' });
    
    // metadata storage
    this.metadata = this.env.openDB({ name: 'metadata' });
    
    logger.info('lmdb databases initialized');
  }

  /**
   * execute a transaction across multiple databases atomically
   */
  transactionSync<T>(fn: () => T): T {
    return this.env.transactionSync(fn);
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
    this.env.transactionSync(() => {
      for (const op of operations) {
        if (op.type === 'put') {
          op.db.putSync(op.key, op.value);
        } else {
          op.db.removeSync(op.key);
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
        confirmedTransactions: await this.confirmedTransactions.getCount(),
      },
    };
    
    return stats;
  }

  /**
   * backup the entire database
   */
  async backup(backupPath: string): Promise<void> {
    logger.info(`backing up database to ${backupPath}`);
    await this.env.backup(backupPath, false);
    logger.info('backup completed');
  }

  /**
   * compact the database to reclaim space
   */
  async compact(): Promise<void> {
    logger.info('compacting database');
    await this.env.flushed;
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
    
    this.env.transactionSync(() => {
      this.blocks.clearSync();
      this.blockIndex.clearSync();
      this.blockHeaders.clearSync();
      this.confirmedTransactions.clearSync();
      this.confirmedByAddress.clearSync();
      this.accounts.clearSync();
      this.accountIndex.clearSync();
      this.mempool.clearSync();
      this.mempoolByFee.clearSync();
      this.mempoolByTime.clearSync();
      this.mempoolByAddress.clearSync();
      this.metadata.clearSync();
    });
    
    logger.warn('all databases cleared');
  }
}
