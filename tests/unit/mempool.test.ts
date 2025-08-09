import { describe, it, expect, beforeEach } from 'bun:test';
import { Mempool, MempoolConfig } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { TransactionClass, createSignedTransaction, getTransactionSize } from '../../src/core/transaction';
import { generateAddress } from '../../src/crypto/address';
import { hexToBytes } from '@noble/hashes/utils';

describe('Mempool', () => {
  let mempool: Mempool;
  let storage: MemoryAdapter;
  
  // test addresses and keys
  const alice = generateAddress();
  const bob = generateAddress();
  const charlie = generateAddress();
  
  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.connect();
    
    const config: MempoolConfig = {
      maxSize: 100,
      maxSizeBytes: 10000,
      minFeePerByte: 1n,
      maxTransactionAge: 60 * 60 * 1000, // 1 hour
      maxTransactionSize: 1000
    };
    
    mempool = new Mempool(storage, config);
    await mempool.initialize();
  });
  
  describe('addTransaction', () => {
    it('should add valid transaction to mempool', async () => {
      const tx = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx);
      
      expect(mempool.hasTransaction(tx.hash)).toBe(true);
      expect(mempool.getTransaction(tx.hash)).toEqual(tx.toObject());
    });
    
    it('should reject duplicate transactions', async () => {
      const tx = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx);
      
      await expect(mempool.addTransaction(tx)).rejects.toThrow('already in mempool');
    });
    
    it('should reject invalid transactions', async () => {
      const tx = new TransactionClass(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        Date.now()
      );
      // not signed
      
      await expect(mempool.addTransaction(tx)).rejects.toThrow('Invalid transaction');
    });
    
    it('should reject transactions with insufficient fee', async () => {
      const tx = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        0n, // no fee
        hexToBytes(alice.privateKey)
      );
      
      await expect(mempool.addTransaction(tx)).rejects.toThrow('Fee too low');
    });
    
    it('should reject oversized transactions', async () => {
      const mempool2 = new Mempool(storage, {
        maxTransactionSize: 100 // very small limit
      });
      
      const tx = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await expect(mempool2.addTransaction(tx)).rejects.toThrow('Transaction too large');
    });
    
    it('should evict lower fee transactions when full', async () => {
      const smallMempool = new Mempool(storage, {
        maxSize: 2,
        minFeePerByte: 1n
      });
      
      // add two transactions with different fees
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        500n, // low fee (but still above minimum of ~452)
        hexToBytes(alice.privateKey)
      );
      
      const tx2 = await createSignedTransaction(
        alice.address,
        charlie.address,
        2000000n,
        1,
        500n, // medium fee
        hexToBytes(alice.privateKey)
      );
      
      await smallMempool.addTransaction(tx1);
      await smallMempool.addTransaction(tx2);
      
      // add high fee transaction - should evict tx1
      const tx3 = await createSignedTransaction(
        bob.address,
        charlie.address,
        3000000n,
        0,
        1000n, // high fee
        hexToBytes(bob.privateKey)
      );
      
      await smallMempool.addTransaction(tx3);
      
      expect(smallMempool.hasTransaction(tx1.hash)).toBe(false); // evicted
      expect(smallMempool.hasTransaction(tx2.hash)).toBe(true);
      expect(smallMempool.hasTransaction(tx3.hash)).toBe(true);
    });
  });
  
  describe('removeTransaction', () => {
    it('should remove transaction from mempool', async () => {
      const tx = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx);
      expect(mempool.hasTransaction(tx.hash)).toBe(true);
      
      await mempool.removeTransaction(tx.hash);
      expect(mempool.hasTransaction(tx.hash)).toBe(false);
    });
    
    it('should handle removing non-existent transaction', async () => {
      await mempool.removeTransaction('nonexistent');
      // should not throw
    });
  });
  
  describe('getTransactionsForBlock', () => {
    it('should return transactions sorted by fee', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        500n, // low fee (just above minimum ~452 watts)
        hexToBytes(alice.privateKey)
      );
      
      const tx2 = await createSignedTransaction(
        bob.address,
        charlie.address,
        2000000n,
        0,
        1000n, // high fee
        hexToBytes(bob.privateKey)
      );
      
      const tx3 = await createSignedTransaction(
        charlie.address,
        alice.address,
        3000000n,
        0,
        750n, // medium fee
        hexToBytes(charlie.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      // add small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 1));
      await mempool.addTransaction(tx2);
      await new Promise(resolve => setTimeout(resolve, 1));
      await mempool.addTransaction(tx3);
      
      const txs = mempool.getTransactionsForBlock();
      
      expect(txs.length).toBe(3);
      
      // tx2 has highest fee per byte (~2 watts/byte)
      expect(txs[0].hash).toBe(tx2.hash);
      
      // tx1 and tx3 both have ~1 watt/byte, but tx1 was added first
      expect(txs[1].hash).toBe(tx1.hash);
      expect(txs[2].hash).toBe(tx3.hash);
    });
    
    it('should respect block size limit', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      const tx2 = await createSignedTransaction(
        bob.address,
        charlie.address,
        2000000n,
        0,
        2000n,
        hexToBytes(bob.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      await mempool.addTransaction(tx2);
      
      const tx1Size = getTransactionSize(tx1.toObject());
      
      // get transactions with size limit that only fits one
      const txs = mempool.getTransactionsForBlock(tx1Size + 10);
      
      expect(txs.length).toBe(1);
      expect(txs[0].hash).toBe(tx2.hash); // higher fee transaction
    });
  });
  
  describe('getStats', () => {
    it('should calculate mempool statistics', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        500n, // ensure fee is high enough (>452 watts)
        hexToBytes(alice.privateKey)
      );
      
      const tx2 = await createSignedTransaction(
        bob.address,
        charlie.address,
        2000000n,
        0,
        1000n,
        hexToBytes(bob.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      await mempool.addTransaction(tx2);
      
      const stats = mempool.getStats();
      
      expect(stats.size).toBe(2);
      expect(stats.totalFees).toBe(1500n); // 500 + 1000
      expect(stats.bytes).toBeGreaterThan(0);
      expect(stats.minFeePerByte).toBeGreaterThan(0n);
      expect(stats.maxFeePerByte).toBeGreaterThan(stats.minFeePerByte);
    });
    
    it('should handle empty mempool stats', () => {
      const stats = mempool.getStats();
      
      expect(stats.size).toBe(0);
      expect(stats.bytes).toBe(0);
      expect(stats.totalFees).toBe(0n);
      expect(stats.minFeePerByte).toBe(0n);
      expect(stats.maxFeePerByte).toBe(0n);
      expect(stats.avgFeePerByte).toBe(0n);
    });
  });
  
  describe('validateAgainstState', () => {
    it('should remove transactions with invalid nonce', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        5, // nonce too high
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      
      // mock state functions
      const getBalance = async (address: string) => 10000000n;
      const getNonce = async (address: string) => 0; // current nonce is 0
      
      await mempool.validateAgainstState(getBalance, getNonce);
      
      expect(mempool.hasTransaction(tx1.hash)).toBe(false);
    });
    
    it('should remove transactions with insufficient balance', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        10000000n, // large amount
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      
      // mock state functions
      const getBalance = async (address: string) => 1000n; // insufficient balance
      const getNonce = async (address: string) => 0;
      
      await mempool.validateAgainstState(getBalance, getNonce);
      
      expect(mempool.hasTransaction(tx1.hash)).toBe(false);
    });
    
    it('should keep valid transactions', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      
      // mock state functions
      const getBalance = async (address: string) => 10000000n; // sufficient balance
      const getNonce = async (address: string) => 0; // correct nonce
      
      await mempool.validateAgainstState(getBalance, getNonce);
      
      expect(mempool.hasTransaction(tx1.hash)).toBe(true);
    });
  });
  
  describe('removeBlockTransactions', () => {
    it('should remove transactions that are in a block', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      const tx2 = await createSignedTransaction(
        bob.address,
        charlie.address,
        2000000n,
        0,
        2000n,
        hexToBytes(bob.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      await mempool.addTransaction(tx2);
      
      // simulate tx1 being included in a block
      await mempool.removeBlockTransactions([tx1.toObject()]);
      
      expect(mempool.hasTransaction(tx1.hash)).toBe(false);
      expect(mempool.hasTransaction(tx2.hash)).toBe(true);
    });
  });
  
  describe('clear', () => {
    it('should clear all transactions', async () => {
      const tx1 = await createSignedTransaction(
        alice.address,
        bob.address,
        1000000n,
        0,
        1000n,
        hexToBytes(alice.privateKey)
      );
      
      await mempool.addTransaction(tx1);
      expect(mempool.getStats().size).toBe(1);
      
      await mempool.clear();
      
      expect(mempool.getStats().size).toBe(0);
      expect(mempool.hasTransaction(tx1.hash)).toBe(false);
    });
  });
});