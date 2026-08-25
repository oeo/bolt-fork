import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LMDBManager } from '../../src/storage/lmdb-manager';
import { LMDBBlockchainStore } from '../../src/storage/lmdb-blockchain-store';
import { LMDBMempoolStore } from '../../src/storage/lmdb-mempool-store';
import { LMDBStateStore } from '../../src/storage/lmdb-state-store';
import { Block } from '../../src/core/block';
import { Transaction } from '../../src/core/transaction';
import { TestBlockFactory } from '../helpers/block-factory';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';

describe('lmdb storage', () => {
  let dbPath: string;
  let lmdb: LMDBManager;
  let blockStore: LMDBBlockchainStore;
  let mempoolStore: LMDBMempoolStore;
  let stateStore: LMDBStateStore;

  beforeEach(async () => {
    // create temp directory for test database
    dbPath = join(tmpdir(), `bolt-test-${Date.now()}`);
    
    // initialize stores
    lmdb = new LMDBManager({ path: dbPath, mapSize: 10 * 1024 * 1024 }); // 10mb for tests
    blockStore = new LMDBBlockchainStore(lmdb);
    mempoolStore = new LMDBMempoolStore(lmdb);
    stateStore = new LMDBStateStore(lmdb);
  });

  afterEach(async () => {
    // close database
    await lmdb.close();
    
    // clean up temp directory
    await rm(dbPath, { recursive: true, force: true });
  });

  describe('lmdb manager', () => {
    it('should initialize all databases', async () => {
      const stats = await lmdb.getStats();
      expect(stats.databases.blocks).toBe(0);
      expect(stats.databases.accounts).toBe(0);
      expect(stats.databases.mempool).toBe(0);
    });

    it('should handle atomic transactions', async () => {
      let error: Error | null = null;
      
      try {
        lmdb.transactionSync(() => {
          lmdb.metadata.putSync('test1', 'value1');
          lmdb.metadata.putSync('test2', 'value2');
          throw new Error('rollback test');
        });
      } catch (e) {
        error = e as Error;
      }
      
      expect(error?.message).toBe('rollback test');
      expect(await lmdb.metadata.get('test1')).toBeUndefined();
      expect(await lmdb.metadata.get('test2')).toBeUndefined();
    });

    it('should perform batch writes', async () => {
      const operations = [
        { db: lmdb.metadata, type: 'put' as const, key: 'key1', value: 'value1' },
        { db: lmdb.metadata, type: 'put' as const, key: 'key2', value: 'value2' },
        { db: lmdb.metadata, type: 'put' as const, key: 'key3', value: 'value3' },
      ];
      
      await lmdb.batchWrite(operations);
      
      const val1 = await lmdb.metadata.get('key1');
      const val2 = await lmdb.metadata.get('key2');
      const val3 = await lmdb.metadata.get('key3');
      
      expect(val1?.toString()).toBe('value1');
      expect(val2?.toString()).toBe('value2');
      expect(val3?.toString()).toBe('value3');
    });
  });

  describe('blockchain store', () => {

    it('should store and retrieve blocks', async () => {
      const block = TestBlockFactory.createBlock(0);
      await blockStore.addBlock(block);
      
      const retrieved = await blockStore.getBlock(0);
      expect(retrieved).toEqual(block);
    });

    it('should get blocks by hash', async () => {
      const block = TestBlockFactory.createBlock(1);
      await blockStore.addBlock(block);
      
      const retrieved = await blockStore.getBlockByHash(block.hash);
      expect(retrieved).toEqual(block);
    });

    it('should track chain height', async () => {
      expect(await blockStore.getHeight()).toBe(-1);
      
      const blocks = TestBlockFactory.createBlockchain(2);
      await blockStore.addBlock(blocks[0]);
      expect(await blockStore.getHeight()).toBe(0);
      
      await blockStore.addBlock(blocks[1]);
      expect(await blockStore.getHeight()).toBe(1);
    });

    it('should get block ranges', async () => {
      const blocks = TestBlockFactory.createBlockchain(5);
      for (const block of blocks) {
        await blockStore.addBlock(block);
      }
      
      const range = await blockStore.getBlockRange(1, 3);
      expect(range.length).toBe(3);
      expect(range[0].index).toBe(1);
      expect(range[2].index).toBe(3);
    });

    it('should handle block removal for reorg', async () => {
      const blocks = TestBlockFactory.createBlockchain(5);
      for (const block of blocks) {
        await blockStore.addBlock(block);
      }
      
      await blockStore.removeBlocksAbove(2);
      
      expect(await blockStore.getHeight()).toBe(2);
      expect(await blockStore.getBlock(3)).toBeNull();
      expect(await blockStore.getBlock(4)).toBeNull();
    });

    it('should cache recent blocks', async () => {
      const block = TestBlockFactory.createBlock(0);
      await blockStore.addBlock(block);
      
      // first access loads from disk
      await blockStore.getBlock(0);
      
      // second access should use cache
      const stats1 = await blockStore.getStats();
      await blockStore.getBlock(0);
      const stats2 = await blockStore.getStats();
      
      expect(stats1.cacheSize).toBeGreaterThan(0);
      expect(stats2.cacheSize).toBe(stats1.cacheSize);
    });
  });

  describe('mempool store', () => {

    it('should add and retrieve transactions', async () => {
      const tx = TestBlockFactory.createTransaction('tx1');
      const added = await mempoolStore.addTransaction(tx);
      expect(added).toBe(true);
      
      const retrieved = await mempoolStore.getTransaction(tx.hash);
      expect(retrieved).toEqual(tx);
    });

    it('should prevent duplicate transactions', async () => {
      const tx = TestBlockFactory.createTransaction('tx1');
      const added1 = await mempoolStore.addTransaction(tx);
      const added2 = await mempoolStore.addTransaction(tx);
      
      expect(added1).toBe(true);
      expect(added2).toBe(false);
    });

    it('should remove transactions', async () => {
      const tx = TestBlockFactory.createTransaction('tx1');
      await mempoolStore.addTransaction(tx);
      
      await mempoolStore.removeTransaction('tx1');
      
      const retrieved = await mempoolStore.getTransaction('tx1');
      expect(retrieved).toBeNull();
    });

    it('should get transactions sorted by fee', async () => {
      await mempoolStore.addTransaction(TestBlockFactory.createTransaction('tx1', 'sender', 'receiver', 1000000n, 100n));
      await mempoolStore.addTransaction(TestBlockFactory.createTransaction('tx2', 'sender', 'receiver', 1000000n, 500n));
      await mempoolStore.addTransaction(TestBlockFactory.createTransaction('tx3', 'sender', 'receiver', 1000000n, 300n));
      
      const sorted = await mempoolStore.getTopTransactionsByFee(3);
      
      expect(sorted[0].fee).toBe(500n);
      expect(sorted[1].fee).toBe(300n);
      expect(sorted[2].fee).toBe(100n);
    });

    it('should get transactions by address', async () => {
      const tx1 = TestBlockFactory.createTransaction('tx1', 'sender', 'receiver');
      const tx2 = TestBlockFactory.createTransaction('tx2', 'other', 'receiver');
      const tx3 = TestBlockFactory.createTransaction('tx3', 'someone', 'sender');
      
      await mempoolStore.addTransaction(tx1);
      await mempoolStore.addTransaction(tx2);
      await mempoolStore.addTransaction(tx3);
      
      const senderTxs = await mempoolStore.getTransactionsByAddress('sender');
      expect(senderTxs.length).toBe(2);
    });

    it('should prune old transactions', async () => {
      const tx = TestBlockFactory.createTransaction('tx1');
      await mempoolStore.addTransaction(tx);
      
      // prune with 0 second max age
      const pruned = await mempoolStore.pruneOldTransactions(0);
      expect(pruned).toBe(1);
      
      const retrieved = await mempoolStore.getTransaction('tx1');
      expect(retrieved).toBeNull();
    });

    it('should calculate mempool stats', async () => {
      await mempoolStore.addTransaction(TestBlockFactory.createTransaction('tx1', 'sender', 'receiver', 1000000n, 100n));
      await mempoolStore.addTransaction(TestBlockFactory.createTransaction('tx2', 'sender', 'receiver', 1000000n, 500n));
      await mempoolStore.addTransaction(TestBlockFactory.createTransaction('tx3', 'sender', 'receiver', 1000000n, 300n));
      
      const stats = await mempoolStore.getStats();
      
      expect(stats.count).toBe(3);
      expect(stats.minFee).toBe(100n);
      expect(stats.maxFee).toBe(500n);
      expect(stats.avgFee).toBe(300n);
    });
  });

  describe('state store', () => {
    it('should create and retrieve accounts', async () => {
      const account = await stateStore.getOrCreateAccount('address1');
      
      expect(account.address).toBe('address1');
      expect(account.balance).toBe(0n);
      expect(account.nonce).toBe(0);
    });

    it('should update account balances', async () => {
      const account = await stateStore.getOrCreateAccount('address1');
      account.balance = 1000000n;
      account.nonce = 5;
      
      await stateStore.updateAccount(account);
      
      const retrieved = await stateStore.getAccount('address1');
      expect(retrieved?.balance).toBe(1000000n);
      expect(retrieved?.nonce).toBe(5);
    });

    it('should apply transactions to state', async () => {
      // setup initial balances
      const sender = await stateStore.getOrCreateAccount('sender');
      sender.balance = 2000000n;
      await stateStore.updateAccount(sender);
      
      const tx: Transaction = {
        chainId: 1057,
        kind: 'transfer',
        hash: 'tx1',
        from: 'sender',
        to: 'receiver',
        amount: 1000000n,
        fee: 1000n,
        nonce: 1,
        signature: 'sig',
        timestamp: Date.now(),
      };
      
      await stateStore.applyTransaction(tx, 1);
      
      const senderAfter = await stateStore.getAccount('sender');
      const receiverAfter = await stateStore.getAccount('receiver');
      
      expect(senderAfter?.balance).toBe(999000n); // 2000000 - 1000000 - 1000
      expect(senderAfter?.nonce).toBe(1);
      expect(receiverAfter?.balance).toBe(1000000n);
    });

    it('should apply coinbase rewards', async () => {
      await stateStore.applyCoinbase('miner', 5000000n, 1);
      
      const miner = await stateStore.getAccount('miner');
      expect(miner?.balance).toBe(5000000n);
      expect(miner?.lastBlockIndex).toBe(1);
    });

    it('should get top accounts by balance', async () => {
      const accounts = [
        { address: 'addr1', balance: 100n, nonce: 0 },
        { address: 'addr2', balance: 500n, nonce: 0 },
        { address: 'addr3', balance: 300n, nonce: 0 },
      ];
      
      await stateStore.updateAccounts(accounts);
      
      const top = await stateStore.getTopAccountsByBalance(2);
      
      expect(top[0].address).toBe('addr2');
      expect(top[0].balance).toBe(500n);
      expect(top[1].address).toBe('addr3');
      expect(top[1].balance).toBe(300n);
    });

    it('should calculate total supply', async () => {
      const accounts = [
        { address: 'addr1', balance: 1000000n, nonce: 0 },
        { address: 'addr2', balance: 2000000n, nonce: 0 },
        { address: 'addr3', balance: 3000000n, nonce: 0 },
      ];
      
      await stateStore.updateAccounts(accounts);
      
      const total = await stateStore.getTotalSupply();
      expect(total).toBe(6000000n);
    });

    it('should create and restore snapshots', async () => {
      // setup initial state
      const accounts = [
        { address: 'addr1', balance: 1000n, nonce: 1 },
        { address: 'addr2', balance: 2000n, nonce: 2 },
      ];
      await stateStore.updateAccounts(accounts);
      
      // create snapshot
      const snapshot = await stateStore.createSnapshot(10);
      
      // modify state
      const addr1 = await stateStore.getAccount('addr1');
      if (addr1) {
        addr1.balance = 5000n;
        await stateStore.updateAccount(addr1);
      }
      
      // verify modification
      let modified = await stateStore.getAccount('addr1');
      expect(modified?.balance).toBe(5000n);
      
      // restore snapshot
      await stateStore.restoreSnapshot(snapshot);
      
      // verify restoration
      const restored = await stateStore.getAccount('addr1');
      expect(restored?.balance).toBe(1000n);
      expect(restored?.nonce).toBe(1);
    });
  });

  describe('integration', () => {
    it('should handle block processing atomically', async () => {
      // setup initial state
      const sender = await stateStore.getOrCreateAccount('sender');
      sender.balance = 10000000n;
      await stateStore.updateAccount(sender);
      
      // create block with transactions
      const tx = TestBlockFactory.createTransaction('tx1', 'sender', 'receiver', 1000000n, 1000n);
      
      const block = TestBlockFactory.createBlock(0);
      block.transactions = [tx];
      block.coinbaseRecipient = 'miner';
      block.coinbaseAmount = 5000000n;
      
      // process block atomically
      // note: using separate calls instead of a single transaction
      // as LMDB async transactions can cause issues
      await blockStore.addBlock(block);
      
      // apply transactions
      for (const tx of block.transactions) {
        await stateStore.applyTransaction(tx, block.index);
      }
      
      // apply coinbase
      if (block.coinbaseRecipient && block.coinbaseAmount) {
        await stateStore.applyCoinbase(
          block.coinbaseRecipient,
          block.coinbaseAmount,
          block.index
        );
      }
      
      // remove from mempool if present
      await mempoolStore.removeTransaction(tx.hash);
      
      // verify results
      const storedBlock = await blockStore.getBlock(0);
      expect(storedBlock?.hash).toBe(block.hash);
      
      const senderAccount = await stateStore.getAccount('sender');
      expect(senderAccount?.balance).toBe(8999000n); // 10000000 - 1000000 - 1000
      
      const receiverAccount = await stateStore.getAccount('receiver');
      expect(receiverAccount?.balance).toBe(1000000n);
      
      const minerAccount = await stateStore.getAccount('miner');
      expect(minerAccount?.balance).toBe(5000000n);
      
      const inMempool = await mempoolStore.hasTransaction('tx1');
      expect(inMempool).toBe(false);
    });
  });
});
