import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MemoryAdapter } from '../../src/storage/memory';
import { StorageAdapter } from '../../src/storage/adapter';
import { Block, Transaction, AccountState } from '../../src/types';

// test with memory adapter (redis tests go in integration)
describe('Storage Adapter', () => {
  let storage: StorageAdapter;
  
  beforeAll(async () => {
    storage = new MemoryAdapter();
    await storage.connect();
  });
  
  afterAll(async () => {
    await storage.close();
  });
  
  describe('Block operations', () => {
    const testBlock: Block = {
      index: 1,
      timestamp: Date.now(),
      previousHash: '0'.repeat(64),
      hash: '1'.repeat(64),
      merkleRoot: '2'.repeat(64),
      stateRoot: '3'.repeat(64),
      difficulty: 10,
      nonce: 12345,
      transactions: [],
      miner: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
    };
    
    it('should save and retrieve block by height', async () => {
      await storage.saveBlock(testBlock);
      const retrieved = await storage.getBlock(1);
      
      expect(retrieved).toEqual(testBlock);
    });
    
    it('should retrieve block by hash', async () => {
      const retrieved = await storage.getBlockByHash('1'.repeat(64));
      expect(retrieved).toEqual(testBlock);
    });
    
    it('should get latest block', async () => {
      const latest = await storage.getLatestBlock();
      expect(latest).toEqual(testBlock);
    });
    
    it('should get chain height', async () => {
      const height = await storage.getChainHeight();
      expect(height).toBe(1);
    });
    
    it('should get block range', async () => {
      const block2: Block = { ...testBlock, index: 2, hash: '2'.repeat(64) };
      await storage.saveBlock(block2);
      
      const range = await storage.getBlockRange(1, 2);
      expect(range.length).toBe(2);
      expect(range[0].index).toBe(1);
      expect(range[1].index).toBe(2);
    });
    
    it('should return null for non-existent block', async () => {
      const block = await storage.getBlock(999);
      expect(block).toBeNull();
    });
  });
  
  describe('Account operations', () => {
    const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
    const state: AccountState = {
      balance: 1000000000n, // 10 BOLT
      nonce: 5
    };
    
    it('should save and retrieve account state', async () => {
      await storage.updateAccountState(address, state);
      const retrieved = await storage.getAccountState(address);
      
      expect(retrieved).toEqual(state);
    });
    
    it('should update account state', async () => {
      const newState: AccountState = {
        balance: 2000000000n,
        nonce: 6
      };
      
      await storage.updateAccountState(address, newState);
      const retrieved = await storage.getAccountState(address);
      
      expect(retrieved).toEqual(newState);
    });
    
    it('should get all account addresses', async () => {
      const address2 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
      await storage.updateAccountState(address2, { balance: 0n, nonce: 0 });
      
      const addresses = await storage.getAllAccountAddresses();
      expect(addresses).toContain(address);
      expect(addresses).toContain(address2);
    });
    
    it('should return null for non-existent account', async () => {
      const state = await storage.getAccountState('invalid');
      expect(state).toBeNull();
    });
  });
  
  describe('Mempool operations', () => {
    const tx: Transaction = {
      chainId: 1057,
      kind: 'transfer',
      hash: 'mempool123',
      from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      amount: 100000000n,
      nonce: 2,
      fee: 20000n,
      timestamp: Date.now()
    };
    
    it('should add transaction to mempool', async () => {
      await storage.addToMempool(tx);
      const inMempool = await storage.isInMempool('mempool123');
      expect(inMempool).toBe(true);
    });
    
    it('should get mempool transactions', async () => {
      const txs = await storage.getMempoolTransactions();
      expect(txs.length).toBeGreaterThan(0);
      expect(txs.map(t => t.hash)).toContain('mempool123');
    });
    
    it('should remove transaction from mempool', async () => {
      await storage.removeFromMempool('mempool123');
      const inMempool = await storage.isInMempool('mempool123');
      expect(inMempool).toBe(false);
    });
    
    it('should clear mempool', async () => {
      await storage.addToMempool(tx);
      await storage.clearMempool();
      
      const txs = await storage.getMempoolTransactions();
      expect(txs.length).toBe(0);
    });
  });
  
  describe('Chain metadata', () => {
    it('should save and retrieve metadata', async () => {
      await storage.saveChainMetadata('version', '0.1.0');
      const version = await storage.getChainMetadata('version');
      expect(version).toBe('0.1.0');
    });
    
    it('should handle object metadata', async () => {
      const config = { network: 'testnet', difficulty: 10 };
      await storage.saveChainMetadata('config', config);
      
      const retrieved = await storage.getChainMetadata('config');
      expect(retrieved).toEqual(config);
    });
  });
  
  describe('Clear operation', () => {
    it('should clear all data', async () => {
      // add some data
      await storage.saveChainMetadata('test', 'value');
      
      // clear everything
      await storage.clear();
      
      // verify everything is gone
      const height = await storage.getChainHeight();
      expect(height).toBe(-1);
      
      const metadata = await storage.getChainMetadata('test');
      expect(metadata).toBeNull();
      
      const txs = await storage.getMempoolTransactions();
      expect(txs.length).toBe(0);
    });
  });
});
