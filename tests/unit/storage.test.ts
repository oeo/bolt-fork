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
  
  describe('Transaction operations', () => {
    const tx: Transaction = {
      hash: 'tx123',
      from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      amount: 100000000n, // 1 BOLT
      nonce: 1,
      fee: 10000n,
      signature: 'sig123',
      publicKey: 'pub123',
      timestamp: Date.now()
    };
    
    it('should save and retrieve transaction', async () => {
      await storage.saveTransaction(tx);
      const retrieved = await storage.getTransaction('tx123');
      
      expect(retrieved).toEqual(tx);
    });
    
    it('should get transactions by address', async () => {
      const tx2: Transaction = {
        ...tx,
        hash: 'tx456',
        from: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
        to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
      };
      
      await storage.saveTransaction(tx2);
      
      // should get both transactions for first address
      const txs = await storage.getTransactionsByAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
      expect(txs.length).toBe(2);
      expect(txs.map(t => t.hash)).toContain('tx123');
      expect(txs.map(t => t.hash)).toContain('tx456');
    });
    
    it('should handle coinbase transactions', async () => {
      const coinbase: Transaction = {
        hash: 'coinbase123',
        from: null, // coinbase has no sender
        to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        amount: 5000000000n, // 50 BOLT reward
        nonce: 0,
        fee: 0n,
        timestamp: Date.now()
      };
      
      await storage.saveTransaction(coinbase);
      const retrieved = await storage.getTransaction('coinbase123');
      
      expect(retrieved).toEqual(coinbase);
      expect(retrieved!.from).toBeNull();
    });
  });
  
  describe('Mempool operations', () => {
    const tx: Transaction = {
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
  
  describe('Cumulative difficulty', () => {
    it('should update and retrieve cumulative difficulty', async () => {
      await storage.updateCumulativeDifficulty(1000n);
      const diff = await storage.getCumulativeDifficulty();
      expect(diff).toBe(1000n);
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