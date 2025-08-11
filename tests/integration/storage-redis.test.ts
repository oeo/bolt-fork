import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { RedisAdapter } from '../../src/storage/redis';
import { Block, Transaction, AccountState } from '../../src/types';

describe('Redis Storage Adapter', () => {
  let storage: RedisAdapter;
  
  beforeAll(async () => {
    storage = new RedisAdapter('localhost', 7337, 1); // use db 1 for tests
    await storage.connect();
    await storage.clear(); // start fresh
  });
  
  afterAll(async () => {
    await storage.clear();
    await storage.close();
  });
  
  describe('Connection', () => {
    it('should connect to Redis', () => {
      expect(storage['isConnected']).toBe(true);
    });
  });
  
  describe('Block operations', () => {
    const testBlock: Block = {
      index: 0,
      timestamp: 1234567890,
      previousHash: '0'.repeat(64),
      hash: 'genesis'.padEnd(64, '0'),
      merkleRoot: '0'.repeat(64),
      difficulty: 1,
      nonce: 0,
      transactions: [],
    };
    
    it('should save and retrieve block', async () => {
      await storage.saveBlock(testBlock);
      const retrieved = await storage.getBlock(0);
      
      expect(retrieved).toEqual(testBlock);
    });
    
    it('should retrieve block by hash', async () => {
      const retrieved = await storage.getBlockByHash('genesis'.padEnd(64, '0'));
      expect(retrieved).toEqual(testBlock);
    });
    
    it('should update chain height', async () => {
      const block1: Block = { ...testBlock, index: 1, hash: '1'.repeat(64) };
      await storage.saveBlock(block1);
      
      const height = await storage.getChainHeight();
      expect(height).toBe(1);
      
      const latest = await storage.getLatestBlock();
      expect(latest).toEqual(block1);
    });
  });
  
  describe('Account operations with bigint', () => {
    it('should handle large bigint values', async () => {
      const address = '1TestAddress';
      const state: AccountState = {
        balance: 2100000000000000n, // 21 million BOLT in satoshis
        nonce: 42
      };
      
      await storage.updateAccountState(address, state);
      const retrieved = await storage.getAccountState(address);
      
      expect(retrieved).toBeTruthy();
      expect(retrieved!.balance).toBe(2100000000000000n);
      expect(retrieved!.nonce).toBe(42);
    });
  });
  
  describe('Transaction operations', () => {
    it('should index transactions by address', async () => {
      const tx1: Transaction = {
        hash: 'tx001',
        from: 'addr1',
        to: 'addr2',
        amount: 1000000n,
        nonce: 1,
        fee: 1000n,
        timestamp: Date.now()
      };
      
      const tx2: Transaction = {
        hash: 'tx002',
        from: 'addr2',
        to: 'addr3',
        amount: 2000000n,
        nonce: 1,
        fee: 2000n,
        timestamp: Date.now()
      };
      
      await storage.saveTransaction(tx1);
      await storage.saveTransaction(tx2);
      
      // addr2 should have both transactions (as receiver in tx1, sender in tx2)
      const addr2Txs = await storage.getTransactionsByAddress('addr2');
      expect(addr2Txs.length).toBe(2);
      expect(addr2Txs.map(t => t.hash).sort()).toEqual(['tx001', 'tx002']);
    });
  });
  
  describe('Mempool operations', () => {
    it('should manage mempool independently from saved transactions', async () => {
      const mempoolTx: Transaction = {
        hash: 'mempool001',
        from: 'sender',
        to: 'receiver',
        amount: 5000000n,
        nonce: 1,
        fee: 5000n,
        timestamp: Date.now()
      };
      
      // add to mempool
      await storage.addToMempool(mempoolTx);
      expect(await storage.isInMempool('mempool001')).toBe(true);
      
      // should be in mempool but not in saved transactions
      const saved = await storage.getTransaction('mempool001');
      expect(saved).toBeNull();
      
      // remove from mempool and save as confirmed
      await storage.removeFromMempool('mempool001');
      await storage.saveTransaction(mempoolTx);
      
      // now should be saved but not in mempool
      expect(await storage.isInMempool('mempool001')).toBe(false);
      const confirmed = await storage.getTransaction('mempool001');
      expect(confirmed).toEqual(mempoolTx);
    });
  });
  
  describe('Metadata operations', () => {
    it('should store different types of metadata', async () => {
      await storage.saveChainMetadata('string_value', 'hello');
      await storage.saveChainMetadata('number_value', 42);
      await storage.saveChainMetadata('object_value', { foo: 'bar', num: 123 });
      
      expect(await storage.getChainMetadata('string_value')).toBe('hello');
      expect(await storage.getChainMetadata('number_value')).toBe(42); // returns as number
      expect(await storage.getChainMetadata('object_value')).toEqual({ foo: 'bar', num: 123 });
    });
  });
});