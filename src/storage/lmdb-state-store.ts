import { LMDBManager } from './lmdb-manager';
import { Transaction } from '../core/transaction';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export interface Account {
  address: string;
  balance: bigint;
  nonce: number;
  lastBlockIndex?: number;
}

interface StateSnapshot {
  blockHeight: number;
  accounts: Map<string, Account>;
  timestamp: number;
}

/**
 * lmdb-backed state storage
 * manages account balances and state
 */
export class LMDBStateStore {
  private lmdb: LMDBManager;
  
  // in-memory cache for frequently accessed accounts
  private accountCache: Map<string, Account> = new Map();
  private readonly cacheSize = 1000;

  constructor(lmdb: LMDBManager) {
    this.lmdb = lmdb;
  }

  /**
   * get an account by address
   */
  async getAccount(address: string): Promise<Account | null> {
    // check cache first
    if (this.accountCache.has(address)) {
      return this.accountCache.get(address)!;
    }
    
    const data = await this.lmdb.accounts.get(address);
    if (!data) return null;
    
    const account = this.deserializeAccount(data);
    this.updateCache(account);
    
    return account;
  }

  /**
   * get or create an account
   */
  async getOrCreateAccount(address: string): Promise<Account> {
    const existing = await this.getAccount(address);
    if (existing) return existing;
    
    const account: Account = {
      address,
      balance: 0n,
      nonce: 0,
    };
    
    await this.updateAccount(account);
    return account;
  }

  /**
   * update an account
   */
  async updateAccount(account: Account): Promise<void> {
    const serialized = this.serializeAccount(account);
    
    // store as binary (Uint8Array)
    await this.lmdb.accounts.put(account.address, serialized);
    this.updateCache(account);
    
    logger.debug(`updated account ${account.address} balance=${account.balance} nonce=${account.nonce}`);
  }

  /**
   * batch update multiple accounts (for block processing)
   */
  async updateAccounts(accounts: Account[]): Promise<void> {
    await this.lmdb.transaction(() => {
      for (const account of accounts) {
        const serialized = this.serializeAccount(account);
        this.lmdb.accounts.put(account.address, serialized);
        this.updateCache(account);
      }
    });
    
    logger.debug(`updated ${accounts.length} accounts`);
  }

  /**
   * get the balance of an account
   */
  async getBalance(address: string): Promise<bigint> {
    const account = await this.getAccount(address);
    return account?.balance ?? 0n;
  }

  /**
   * set the balance of an account
   */
  async setBalance(address: string, balance: bigint): Promise<void> {
    const account = await this.getOrCreateAccount(address);
    account.balance = balance;
    await this.updateAccount(account);
  }

  /**
   * get the nonce of an account
   */
  async getNonce(address: string): Promise<number> {
    const account = await this.getAccount(address);
    return account?.nonce ?? 0;
  }

  /**
   * set the nonce of an account
   */
  async setNonce(address: string, nonce: number): Promise<void> {
    const account = await this.getOrCreateAccount(address);
    account.nonce = nonce;
    await this.updateAccount(account);
  }

  /**
   * get account state (balance and nonce)
   */
  async getAccountState(address: string): Promise<{ balance: bigint; nonce: number } | null> {
    const account = await this.getAccount(address);
    if (!account) return null;
    return {
      balance: account.balance,
      nonce: account.nonce
    };
  }

  /**
   * set account state
   */
  async setAccountState(address: string, state: { balance: bigint; nonce: number }): Promise<void> {
    const account = await this.getOrCreateAccount(address);
    account.balance = state.balance;
    account.nonce = state.nonce;
    await this.updateAccount(account);
  }

  /**
   * update account state (alias for setAccountState)
   */
  async updateAccountState(address: string, state: { balance: bigint; nonce: number }): Promise<void> {
    return this.setAccountState(address, state);
  }

  /**
   * get all balances as a map
   */
  async getAllBalances(): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    
    for await (const { key, value } of this.lmdb.accounts.getRange()) {
      const account = this.deserializeAccount(value);
      balances.set(account.address, account.balance);
    }
    
    return balances;
  }

  /**
   * apply a transaction to the state
   */
  async applyTransaction(tx: Transaction, blockIndex: number): Promise<void> {
    await this.lmdb.transaction(async () => {
      // get or create sender account
      const sender = await this.getOrCreateAccount(tx.from);
      
      // update sender
      sender.balance -= tx.amount + tx.fee;
      sender.nonce++;
      sender.lastBlockIndex = blockIndex;
      await this.updateAccount(sender);
      
      // update receiver (if not a contract creation)
      if (tx.to) {
        const receiver = await this.getOrCreateAccount(tx.to);
        receiver.balance += tx.amount;
        receiver.lastBlockIndex = blockIndex;
        await this.updateAccount(receiver);
      }
    });
    
    logger.debug(`applied transaction ${tx.hash} to state`);
  }

  /**
   * apply a coinbase reward
   */
  async applyCoinbase(minerAddress: string, amount: bigint, blockIndex: number): Promise<void> {
    const miner = await this.getOrCreateAccount(minerAddress);
    miner.balance += amount;
    miner.lastBlockIndex = blockIndex;
    await this.updateAccount(miner);
    
    logger.debug(`applied coinbase reward ${amount} to ${minerAddress}`);
  }

  /**
   * revert state to a previous block height
   */
  async revertToHeight(targetHeight: number): Promise<void> {
    // this would require maintaining state snapshots or transaction history
    // for now, throw an error as this needs more complex implementation
    throw new Error('state reversion not yet implemented in lmdb store');
  }

  /**
   * get all accounts (paginated)
   */
  async getAccounts(limit: number = 100, offset: number = 0): Promise<Account[]> {
    const accounts: Account[] = [];
    let count = 0;
    
    for await (const { value } of this.lmdb.accounts.getRange()) {
      if (count >= offset && accounts.length < limit) {
        accounts.push(this.deserializeAccount(value));
      }
      count++;
      if (accounts.length >= limit) break;
    }
    
    return accounts;
  }

  /**
   * get accounts by balance (richlist)
   */
  async getTopAccountsByBalance(limit: number): Promise<Account[]> {
    const accounts: Account[] = [];
    
    // load all accounts (inefficient for large datasets)
    for await (const { value } of this.lmdb.accounts.getRange()) {
      accounts.push(this.deserializeAccount(value));
    }
    
    // sort by balance descending
    accounts.sort((a, b) => {
      if (a.balance > b.balance) return -1;
      if (a.balance < b.balance) return 1;
      return 0;
    });
    
    return accounts.slice(0, limit);
  }

  /**
   * get total supply (sum of all balances)
   */
  async getTotalSupply(): Promise<bigint> {
    let total = 0n;
    
    for await (const { value } of this.lmdb.accounts.getRange()) {
      const account = this.deserializeAccount(value);
      total += account.balance;
    }
    
    return total;
  }

  /**
   * get state statistics
   */
  async getStats(): Promise<any> {
    const accountCount = await this.lmdb.accounts.getCount();
    const totalSupply = await this.getTotalSupply();
    
    return {
      accountCount,
      totalSupply: totalSupply.toString(),
      cacheSize: this.accountCache.size,
    };
  }

  /**
   * create a state snapshot
   */
  async createSnapshot(blockHeight: number): Promise<StateSnapshot> {
    const accounts = new Map<string, Account>();
    
    for await (const { key, value } of this.lmdb.accounts.getRange()) {
      accounts.set(key, this.deserializeAccount(value));
    }
    
    return {
      blockHeight,
      accounts,
      timestamp: Date.now(),
    };
  }

  /**
   * restore from a state snapshot
   */
  async restoreSnapshot(snapshot: StateSnapshot): Promise<void> {
    await this.lmdb.transaction(async () => {
      // clear current state
      await this.lmdb.accounts.clearAsync();
      
      // restore from snapshot
      for (const [address, account] of snapshot.accounts) {
        const serialized = this.serializeAccount(account);
        this.lmdb.accounts.put(address, serialized);
      }
      
      // update metadata (convert numbers to strings)
      this.lmdb.metadata.put('stateHeight', snapshot.blockHeight.toString());
      this.lmdb.metadata.put('stateTimestamp', snapshot.timestamp.toString());
    });
    
    // clear cache
    this.accountCache.clear();
    
    logger.info(`restored state from snapshot at height ${snapshot.blockHeight}`);
  }

  /**
   * clear all state
   */
  async clear(): Promise<void> {
    await this.lmdb.accounts.clearAsync();
    this.accountCache.clear();
    logger.info('state cleared');
  }

  // helper methods
  
  private serializeAccount(account: Account): Uint8Array {
    // use bun's fast encoding
    const json = JSON.stringify({
      address: account.address,
      balance: account.balance.toString(), // bigint as string
      nonce: account.nonce,
      lastBlockIndex: account.lastBlockIndex,
    });
    
    // convert to binary using bun's fast encoder
    const encoder = new TextEncoder();
    return encoder.encode(json);
  }

  private deserializeAccount(data: Uint8Array): Account {
    // use bun's fast decoder
    const decoder = new TextDecoder();
    const json = decoder.decode(data);
    const parsed = JSON.parse(json);
    
    return {
      address: parsed.address,
      balance: BigInt(parsed.balance),
      nonce: parsed.nonce,
      lastBlockIndex: parsed.lastBlockIndex,
    };
  }

  private updateCache(account: Account): void {
    // add to cache
    this.accountCache.set(account.address, account);
    
    // remove oldest if cache is full
    if (this.accountCache.size > this.cacheSize) {
      const firstKey = this.accountCache.keys().next().value;
      this.accountCache.delete(firstKey);
    }
  }
}