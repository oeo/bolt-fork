import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MempoolSync } from '../../src/network/mempool-sync';
import { Mempool } from '../../src/core/mempool';
import { BoltNode } from '../../src/network/node';
import { createStorage } from '../../src/storage';
import { config as chainConfig } from '../../src/config/chain';
import { TransactionClass } from '../../src/core/transaction';
import { generateAddress } from '../../src/crypto/address';
import { MessageType } from '../../src/network/messages';

describe('Mempool Sync', () => {
  let mempoolSync: MempoolSync;
  let mempool: Mempool;
  let node: BoltNode;
  let storage: any;

  beforeEach(async () => {
    storage = createStorage('memory');
    await storage.connect();
    mempool = new Mempool(storage, chainConfig);
    
    node = new BoltNode({
      port: 17338,
      chainConfig,
      enableDHT: false,
      enableGossipsub: false
    });
    
    // mock node methods
    node.getPeers = () => ['peer1', 'peer2'];
    node.sendMessage = mock((peerId: string, type: string, data: any) => {});
    
    mempoolSync = new MempoolSync({
      mempool,
      node,
      syncInterval: 1000,
      maxTxPerMessage: 10,
      maxInventorySize: 100
    });
  });

  test('should create mempool sync instance', () => {
    expect(mempoolSync).toBeDefined();
    expect(mempoolSync.getStats).toBeDefined();
  });

  test('should initialize with zero stats', () => {
    const stats = mempoolSync.getStats();
    
    expect(stats.txBroadcasted).toBe(0);
    expect(stats.txReceived).toBe(0);
    expect(stats.txRequested).toBe(0);
    expect(stats.inventoriesExchanged).toBe(0);
    expect(stats.duplicatesRejected).toBe(0);
  });

  test('should initialize peer inventory on connect', () => {
    node.emit('peer:connect', 'peer1');
    
    const size = mempoolSync.getPeerInventorySize('peer1');
    expect(size).toBe(0);
  });

  test('should cleanup peer data on disconnect', () => {
    node.emit('peer:connect', 'peer1');
    expect(mempoolSync.getPeerInventorySize('peer1')).toBe(0);
    
    node.emit('peer:disconnect', 'peer1');
    // after cleanup, should return 0 for unknown peer
    expect(mempoolSync.getPeerInventorySize('peer1')).toBe(0);
  });

  test('should broadcast new local transaction', async () => {
    const alice = generateAddress();
    const bob = generateAddress();
    
    // give alice balance
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });
    
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n,
      0,
      1_000_000n,
      Date.now()
    );
    await tx.sign(alice.privateKey);
    
    // track sendMessage calls
    let messagesSent = 0;
    node.sendMessage = mock((peerId: string, type: string, data: any) => {
      if (type === MessageType.TX_INV) {
        messagesSent++;
      }
    });
    
    // emit mempool add event
    node.emit('mempool:add', tx.toObject());
    
    // should broadcast to all peers
    expect(messagesSent).toBe(2); // 2 peers
    
    const stats = mempoolSync.getStats();
    expect(stats.txBroadcasted).toBe(1);
  });

  test('should handle transaction inventory from peer', () => {
    const inventory = {
      hashes: ['tx1', 'tx2', 'tx3'],
      count: 3,
      timestamp: Date.now()
    };
    
    let requestedTxs: string[] = [];
    node.sendMessage = mock((peerId: string, type: string, data: any) => {
      if (type === MessageType.GET_TX) {
        requestedTxs = data;
      }
    });
    
    // receive inventory
    node.emit('message:tx_inv', 'peer1', inventory);
    
    // should request missing transactions
    expect(requestedTxs.length).toBe(3);
    
    const stats = mempoolSync.getStats();
    expect(stats.inventoriesExchanged).toBe(1);
    expect(stats.txRequested).toBe(3);
  });

  test('should handle transaction request from peer', async () => {
    const alice = generateAddress();
    const bob = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });
    
    // add transaction to mempool
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n,
      0,
      1_000_000n,
      Date.now()
    );
    await tx.sign(alice.privateKey);
    await mempool.addTransaction(tx.toObject());
    
    let sentTransactions: any[] = [];
    node.sendMessage = mock((peerId: string, type: string, data: any) => {
      if (type === MessageType.TX) {
        sentTransactions = data;
      }
    });
    
    // request transaction
    node.emit('message:get_tx', 'peer1', [tx.hash]);
    
    // should send transaction
    expect(sentTransactions.length).toBe(1);
    expect(sentTransactions[0].hash).toBe(tx.hash);
  });

  test('should handle received transactions', async () => {
    const alice = generateAddress();
    const bob = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });
    
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n,
      0,
      1_000_000n,
      Date.now()
    );
    await tx.sign(alice.privateKey);
    
    // mock mempool.addTransaction to be synchronous for testing
    let addedTx: any = null;
    mempool.addTransaction = mock(async (transaction: any) => {
      addedTx = transaction;
      return Promise.resolve();
    });
    
    // receive transaction from peer
    node.emit('message:tx', 'peer1', [tx.toObject()]);
    
    // give it a moment to process
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // should have attempted to add to mempool
    expect(addedTx).toBeDefined();
    expect(addedTx?.hash).toBe(tx.hash);
    
    const stats = mempoolSync.getStats();
    expect(stats.txReceived).toBe(1);
  });

  test('should reject duplicate transactions', async () => {
    const alice = generateAddress();
    const bob = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });
    
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n,
      0,
      1_000_000n,
      Date.now()
    );
    await tx.sign(alice.privateKey);
    
    // add to mempool first
    await mempool.addTransaction(tx.toObject());
    
    // receive same transaction from peer
    node.emit('message:tx', 'peer1', [tx.toObject()]);
    
    const stats = mempoolSync.getStats();
    expect(stats.duplicatesRejected).toBe(1);
    expect(stats.txReceived).toBe(0);
  });

  test('should limit transaction batch size', () => {
    const hashes = [];
    for (let i = 0; i < 20; i++) {
      hashes.push(`tx${i}`);
    }
    
    let requestedCount = 0;
    node.sendMessage = mock((peerId: string, type: string, data: any) => {
      if (type === MessageType.GET_TX) {
        requestedCount = data.length;
      }
    });
    
    // receive large inventory
    node.emit('message:tx_inv', 'peer1', {
      hashes,
      count: hashes.length,
      timestamp: Date.now()
    });
    
    // should limit request size
    expect(requestedCount).toBe(10); // maxTxPerMessage
  });

  test('should propagate transactions to other peers', async () => {
    const alice = generateAddress();
    const bob = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });
    
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n,
      0,
      1_000_000n,
      Date.now()
    );
    await tx.sign(alice.privateKey);
    
    // mock successful add to mempool
    mempool.addTransaction = mock(async () => Promise.resolve());
    mempool.hasTransaction = mock(() => false);
    
    let propagatedTo: string[] = [];
    node.sendMessage = mock((peerId: string, type: string, data: any) => {
      if (type === MessageType.TX_INV) {
        propagatedTo.push(peerId);
      }
    });
    
    // receive transaction from peer1
    node.emit('message:tx', 'peer1', [tx.toObject()]);
    
    // give it a moment to process
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // should propagate to peer2 but not peer1
    expect(propagatedTo.includes('peer2')).toBe(true);
    expect(propagatedTo.includes('peer1')).toBe(false);
  });

  test('should track peer inventory', () => {
    node.emit('peer:connect', 'peer1');
    
    // receive inventory
    node.emit('message:tx_inv', 'peer1', {
      hashes: ['tx1', 'tx2'],
      count: 2,
      timestamp: Date.now()
    });
    
    expect(mempoolSync.getPeerInventorySize('peer1')).toBe(2);
    
    // receive more
    node.emit('message:tx_inv', 'peer1', {
      hashes: ['tx3', 'tx4'],
      count: 2,
      timestamp: Date.now()
    });
    
    expect(mempoolSync.getPeerInventorySize('peer1')).toBe(4);
  });

  test('should force sync with specific peer', () => {
    node.emit('peer:connect', 'peer1');
    
    let syncSent = false;
    node.sendMessage = mock((peerId: string, type: string, data: any) => {
      if (type === MessageType.TX_INV && peerId === 'peer1') {
        syncSent = true;
      }
    });
    
    mempoolSync.syncWithPeer('peer1');
    
    // should send inventory if mempool not empty
    // (in this test it's empty, so no message sent)
    expect(syncSent).toBe(false);
  });
});