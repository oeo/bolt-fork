import Redis from 'ioredis';
import { StorageAdapter } from './adapter';
import { Block, Transaction, AccountState } from '../types';
import { getLogger } from '../utils/logger';
import { serialize, deserialize } from '../utils/bigint';

const logger = getLogger(__filename);

/**
 * redis implementation of storage adapter
 */
export class RedisAdapter extends StorageAdapter {
  private redis: Redis | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly db: number;
  private readonly keyPrefix: string;
  private readonly password?: string;
  
  constructor(
    host: string = 'localhost', 
    port: number = 7337, 
    db: number = 0,
    keyPrefix: string = '',
    password?: string
  ) {
    super();
    this.host = host;
    this.port = port;
    this.db = db;
    this.keyPrefix = keyPrefix;
    this.password = password;
  }
  
  async connect(): Promise<void> {
    try {
      this.redis = new Redis({
        host: this.host,
        port: this.port,
        db: this.db,
        password: this.password,
        keyPrefix: this.keyPrefix,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          logger.warn(`Redis connection retry ${times}, delay ${delay}ms`);
          return delay;
        }
      });
      
      // test connection
      await this.redis.ping();
      this.isConnected = true;
      logger.info(`Connected to Redis at ${this.host}:${this.port}`);
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }
  
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.isConnected = false;
      logger.info('Disconnected from Redis');
    }
  }
  
  async clear(): Promise<void> {
    this.checkConnection();
    await this.redis!.flushdb();
    logger.warn('Cleared all data from Redis');
  }
  
  async getStorageStats(): Promise<{
    used: number;
    keys: number;
    type: string;
  }> {
    this.checkConnection();
    
    try {
      // get memory info from redis
      const info = await this.redis!.info('memory');
      const memoryUsed = info.match(/used_memory:(\d+)/)?.[1] || '0';
      
      // get key count
      const dbSize = await this.redis!.dbsize();
      
      return {
        used: parseInt(memoryUsed),
        keys: dbSize,
        type: 'redis'
      };
    } catch (error) {
      logger.error('Failed to get Redis storage stats', error);
      return {
        used: 0,
        keys: 0,
        type: 'redis'
      };
    }
  }
  
  // block operations
  
  async saveBlock(block: Block): Promise<void> {
    this.checkConnection();
    const multi = this.redis!.multi();
    
    // save block by height
    multi.set(`block:${block.index}`, serialize(block));
    
    // save block hash to height mapping
    multi.set(`block:hash:${block.hash}`, block.index.toString());
    
    // update latest block
    const current = await this.getChainHeight();
    if (block.index > current) {
      multi.set('chain:height', block.index.toString());
      multi.set('chain:latest', serialize(block));
    }
    
    await multi.exec();
    logger.debug(`Saved block ${block.index} with hash ${block.hash}`);
  }
  
  async getBlock(height: number): Promise<Block | null> {
    this.checkConnection();
    const data = await this.redis!.get(`block:${height}`);
    if (!data) return null;
    
    return deserialize(data);
  }
  
  async getBlockByHash(hash: string): Promise<Block | null> {
    this.checkConnection();
    const height = await this.redis!.get(`block:hash:${hash}`);
    if (!height) return null;
    
    return this.getBlock(parseInt(height));
  }
  
  async getLatestBlock(): Promise<Block | null> {
    this.checkConnection();
    const data = await this.redis!.get('chain:latest');
    if (!data) return null;
    
    return deserialize(data);
  }
  
  async getBlockRange(start: number, end: number): Promise<Block[]> {
    this.checkConnection();
    const blocks: Block[] = [];
    
    for (let i = start; i <= end; i++) {
      const block = await this.getBlock(i);
      if (block) blocks.push(block);
    }
    
    return blocks;
  }
  
  async getChainHeight(): Promise<number> {
    this.checkConnection();
    const height = await this.redis!.get('chain:height');
    return height ? parseInt(height) : -1;
  }
  
  // account operations
  
  async getAccountState(address: string): Promise<AccountState | null> {
    this.checkConnection();
    const data = await this.redis!.get(`account:${address}`);
    if (!data) return null;
    
    const parsed = deserialize(data);
    return {
      balance: typeof parsed.balance === 'bigint' ? parsed.balance : BigInt(parsed.balance),
      nonce: parsed.nonce
    };
  }
  
  async updateAccountState(address: string, state: AccountState): Promise<void> {
    this.checkConnection();
    const data = {
      balance: state.balance.toString(),
      nonce: state.nonce
    };
    
    await this.redis!.set(`account:${address}`, serialize(state));
    logger.debug(`Updated account ${address}: balance=${state.balance}, nonce=${state.nonce}`);
  }
  
  async getAllAccountAddresses(): Promise<string[]> {
    this.checkConnection();
    const keys = await this.redis!.keys('account:*');
    return keys.map(key => key.replace('account:', ''));
  }
  
  // chain operations
  
  async getCumulativeDifficulty(): Promise<bigint> {
    this.checkConnection();
    const diff = await this.redis!.get('chain:cumulative_difficulty');
    return diff ? BigInt(diff) : 0n;
  }
  
  async updateCumulativeDifficulty(difficulty: bigint): Promise<void> {
    this.checkConnection();
    await this.redis!.set('chain:cumulative_difficulty', difficulty.toString());
    logger.debug(`Updated cumulative difficulty to ${difficulty}`);
  }
  
  // transaction operations
  
  async getTransaction(hash: string): Promise<Transaction | null> {
    this.checkConnection();
    const data = await this.redis!.get(`tx:${hash}`);
    if (!data) return null;
    
    return deserialize(data);
  }
  
  async saveTransaction(tx: Transaction): Promise<void> {
    this.checkConnection();
    await this.redis!.set(`tx:${tx.hash}`, serialize(tx));
    
    // index by address
    if (tx.from) {
      await this.redis!.sadd(`tx:from:${tx.from}`, tx.hash);
    }
    await this.redis!.sadd(`tx:to:${tx.to}`, tx.hash);
    
    logger.debug(`Saved transaction ${tx.hash}`);
  }
  
  async getTransactionsByAddress(address: string): Promise<Transaction[]> {
    this.checkConnection();
    
    // get transaction hashes where address is sender or receiver
    const fromHashes = await this.redis!.smembers(`tx:from:${address}`);
    const toHashes = await this.redis!.smembers(`tx:to:${address}`);
    
    const allHashes = [...new Set([...fromHashes, ...toHashes])];
    const transactions: Transaction[] = [];
    
    for (const hash of allHashes) {
      const tx = await this.getTransaction(hash);
      if (tx) transactions.push(tx);
    }
    
    return transactions;
  }
  
  // mempool operations
  
  async addToMempool(tx: Transaction): Promise<void> {
    this.checkConnection();
    await this.redis!.hset('mempool', tx.hash, serialize(tx));
    logger.debug(`Added transaction ${tx.hash} to mempool`);
  }
  
  async removeFromMempool(txHash: string): Promise<void> {
    this.checkConnection();
    await this.redis!.hdel('mempool', txHash);
    logger.debug(`Removed transaction ${txHash} from mempool`);
  }
  
  async getMempoolTransactions(): Promise<Transaction[]> {
    this.checkConnection();
    const data = await this.redis!.hgetall('mempool');
    
    return Object.values(data).map(json => {
      const parsed = JSON.parse(json);
      return {
        ...parsed,
        amount: BigInt(parsed.amount),
        fee: BigInt(parsed.fee)
      };
    });
  }
  
  async clearMempool(): Promise<void> {
    this.checkConnection();
    await this.redis!.del('mempool');
    logger.debug('Cleared mempool');
  }
  
  async isInMempool(txHash: string): Promise<boolean> {
    this.checkConnection();
    const exists = await this.redis!.hexists('mempool', txHash);
    return exists === 1;
  }
  
  // chain metadata
  
  async saveChainMetadata(key: string, value: any): Promise<void> {
    this.checkConnection();
    const data = typeof value === 'object' ? serialize(value) : value.toString();
    await this.redis!.set(`meta:${key}`, data);
  }
  
  async getChainMetadata(key: string): Promise<any> {
    this.checkConnection();
    const data = await this.redis!.get(`meta:${key}`);
    if (!data) return null;
    
    try {
      return deserialize(data);
    } catch {
      return data;
    }
  }
  
  // custom data storage methods for services like GBT
  
  async setCustomData(key: string, value: string, ttl?: number): Promise<void> {
    this.checkConnection();
    if (ttl) {
      await this.redis!.setex(key, ttl, value);
    } else {
      await this.redis!.set(key, value);
    }
  }
  
  async getCustomData(key: string): Promise<string | null> {
    this.checkConnection();
    return await this.redis!.get(key);
  }
  
  async deleteCustomData(key: string): Promise<void> {
    this.checkConnection();
    await this.redis!.del(key);
  }
  
  async addToSet(key: string, value: string): Promise<void> {
    this.checkConnection();
    await this.redis!.sadd(key, value);
  }
  
  async removeFromSet(key: string, value: string): Promise<void> {
    this.checkConnection();
    await this.redis!.srem(key, value);
  }
  
  async getSetMembers(key: string): Promise<string[]> {
    this.checkConnection();
    return await this.redis!.smembers(key);
  }
}