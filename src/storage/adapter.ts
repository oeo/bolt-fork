import { Block, Transaction, AccountState } from '../types';

export interface ChainPoint {
  height: number;
  hash: string | null;
}

export interface CanonicalTransition {
  expectedTip: ChainPoint;
  expectedCumulativeDifficulty: bigint;
  ancestor: ChainPoint;
  blocks: Block[];
  accountStates: Array<{ address: string; state: AccountState }>;
  cumulativeDifficulty: bigint;
  mempoolAdditions: PersistedMempoolEntry[];
  mempoolRemovals: string[];
}

export interface PersistedMempoolEntry {
  transaction: Transaction;
  addedAt: number;
}

export interface MempoolAdmissionState {
  tip: ChainPoint;
  accountState: AccountState | null;
}

export interface MempoolUpdate {
  expectedTip: ChainPoint;
  additions: PersistedMempoolEntry[];
  removals: string[];
}

export interface MempoolPolicy {
  maxSize: number;
  maxSizeBytes: number;
  maxTransactionSize: number;
  minFeePerByte: bigint;
}

export type CanonicalMempoolListener = (
  additions: PersistedMempoolEntry[],
  removals: string[]
) => void;

export class StaleChainTipError extends Error {
  constructor(public readonly actualTip: ChainPoint) {
    super(`Chain tip changed to ${actualTip.height}:${actualTip.hash ?? 'null'}`);
  }
}

/**
 * abstract storage adapter interface
 * all storage implementations must extend this class
 */
export abstract class StorageAdapter {
  protected isConnected: boolean = false;
  private canonicalMempoolListeners = new Set<CanonicalMempoolListener>();
  private stateWriteTail: Promise<void> = Promise.resolve();
  private mempoolPolicy: MempoolPolicy | null = null;

  setMempoolPolicy(policy: MempoolPolicy): void {
    this.mempoolPolicy = policy;
  }

  getMempoolPolicy(): MempoolPolicy | null {
    return this.mempoolPolicy;
  }

  onCanonicalMempoolUpdate(listener: CanonicalMempoolListener): () => void {
    this.canonicalMempoolListeners.add(listener);
    return () => this.canonicalMempoolListeners.delete(listener);
  }

  protected publishCanonicalMempoolUpdate(
    additions: PersistedMempoolEntry[],
    removals: string[]
  ): unknown[] {
    const errors: unknown[] = [];
    for (const listener of this.canonicalMempoolListeners) {
      try {
        listener(additions, removals);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async withStateWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateWriteTail;
    let release!: () => void;
    this.stateWriteTail = new Promise(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  
  /**
   * initialize the storage connection
   */
  abstract connect(): Promise<void>;
  
  /**
   * close the storage connection
   */
  abstract close(): Promise<void>;
  
  /**
   * clear all data (use with caution!)
   */
  abstract clear(): Promise<void>;
  
  /**
   * get storage statistics
   */
  abstract getStorageStats(): Promise<{
    used: number;
    keys: number;
    type: string;
  }>;
  
  // block operations
  
  /**
   * save a block to storage
   */
  abstract saveBlock(block: Block): Promise<void>;

  abstract transitionCanonicalChain(transition: CanonicalTransition): Promise<void>;
  
  /**
   * get a block by its height/index
   */
  abstract getBlock(height: number): Promise<Block | null>;
  
  /**
   * get a block by its hash
   */
  abstract getBlockByHash(hash: string): Promise<Block | null>;
  
  /**
   * get the latest block in the chain
   */
  abstract getLatestBlock(): Promise<Block | null>;
  
  /**
   * get a range of blocks
   */
  abstract getBlockRange(start: number, end: number): Promise<Block[]>;
  
  /**
   * get the current blockchain height
   */
  abstract getChainHeight(): Promise<number>;
  
  // account operations
  
  /**
   * get account state (balance and nonce)
   */
  abstract getAccountState(address: string): Promise<AccountState | null>;
  
  /**
   * update account state
   */
  abstract updateAccountState(address: string, state: AccountState): Promise<void>;
  
  /**
   * get all account addresses
   */
  abstract getAllAccountAddresses(): Promise<string[]>;
  
  // chain operations
  
  /**
   * get cumulative difficulty of the chain
   */
  abstract getCumulativeDifficulty(): Promise<bigint>;
  
  /**
   * update cumulative difficulty
   */
  abstract updateCumulativeDifficulty(difficulty: bigint): Promise<void>;
  
  // transaction operations
  
  /**
   * get a transaction by its hash
   */
  abstract getTransaction(hash: string): Promise<Transaction | null>;
  
  /**
   * save a transaction
   */
  abstract saveTransaction(tx: Transaction): Promise<void>;
  
  /**
   * get transactions for a specific address
   */
  abstract getTransactionsByAddress(address: string): Promise<Transaction[]>;
  
  // mempool operations
  
  /**
   * add transaction to mempool
   */
  abstract addToMempool(tx: Transaction): Promise<void>;
  
  /**
   * remove transaction from mempool
   */
  abstract removeFromMempool(txHash: string): Promise<void>;
  
  /**
   * get all mempool transactions
   */
  abstract getMempoolTransactions(): Promise<Transaction[]>;

  abstract getMempoolEntries(): Promise<PersistedMempoolEntry[]>;

  abstract getMempoolAdmissionState(address: string): Promise<MempoolAdmissionState>;

  abstract updateMempool(update: MempoolUpdate): Promise<void>;
  
  /**
   * clear the mempool
   */
  abstract clearMempool(): Promise<void>;
  
  /**
   * check if transaction exists in mempool
   */
  abstract isInMempool(txHash: string): Promise<boolean>;
  
  // chain metadata
  
  /**
   * save chain metadata (version, network, etc)
   */
  abstract saveChainMetadata(key: string, value: any): Promise<void>;
  
  /**
   * get chain metadata
   */
  abstract getChainMetadata(key: string): Promise<any>;
  
  // custom data storage methods for services like GBT
  
  /**
   * set custom data with optional TTL
   */
  abstract setCustomData(key: string, value: string, ttl?: number): Promise<void>;
  
  /**
   * get custom data
   */
  abstract getCustomData(key: string): Promise<string | null>;
  
  /**
   * delete custom data
   */
  abstract deleteCustomData(key: string): Promise<void>;
  
  /**
   * add value to a set
   */
  abstract addToSet(key: string, value: string): Promise<void>;
  
  /**
   * remove value from a set
   */
  abstract removeFromSet(key: string, value: string): Promise<void>;
  
  /**
   * get all members of a set
   */
  abstract getSetMembers(key: string): Promise<string[]>;
  
  // helper methods
  
  /**
   * check if storage is connected
   */
  checkConnection(): void {
    if (!this.isConnected) {
      throw new Error('Storage adapter not connected. Call connect() first.');
    }
  }
  
  /**
   * batch operations wrapper (optional override)
   */
  async batch<T>(operations: (() => Promise<T>)[]): Promise<T[]> {
    return Promise.all(operations.map(op => op()));
  }
}
