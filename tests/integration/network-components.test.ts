import { describe, it, expect, beforeEach } from 'bun:test';
import { BlockDownloader } from '../../src/network/block-downloader';
import { InventoryManager } from '../../src/network/inventory-manager';
import { OrphanPool } from '../../src/network/orphan-pool';
import { TransactionRelay } from '../../src/network/transaction-relay';
import { ConnectionManager } from '../../src/network/connection-manager';
import { Protocol } from '../../src/network/protocol';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { getChainConfig } from '../../src/config/chain';
import type { Block } from '../../src/core/block';
import type { Transaction } from '../../src/core/transaction';

describe('block downloader', () => {
  let downloader: BlockDownloader;
  let connectionManager: ConnectionManager;
  let protocol: Protocol;
  
  beforeEach(() => {
    connectionManager = new ConnectionManager({
      nodeId: 'test',
      tcpPort: 9300
    });
    protocol = new Protocol();
    
    downloader = new BlockDownloader({
      connectionManager,
      protocol,
      maxInFlight: 4,
      downloadTimeout: 1000
    });
  });
  
  it('should queue blocks for download', () => {
    const hashes = ['block1', 'block2', 'block3'];
    downloader.queueBlocks(hashes);
    
    const stats = downloader.getStats();
    expect(stats.queueSize).toBe(3);
    expect(stats.downloading).toBe(true);
  });
  
  it('should handle block receipt', () => {
    // simulate in-flight request
    downloader['inFlight'].set('block1', {
      hash: 'block1',
      peerId: 'peer1',
      timestamp: Date.now(),
      retries: 0
    });
    
    let blockReceived = false;
    downloader.on('block:received', () => {
      blockReceived = true;
    });
    
    downloader.handleBlockReceived('peer1', 'block1');
    
    expect(blockReceived).toBe(true);
    expect(downloader['inFlight'].has('block1')).toBe(false);
  });
  
  it('should retry failed downloads', async () => {
    // add old request that should timeout
    downloader['inFlight'].set('block1', {
      hash: 'block1',
      peerId: 'peer1',
      timestamp: Date.now() - 2000, // 2 seconds ago
      retries: 0
    });
    
    let retried = false;
    downloader.on('block:retry', () => {
      retried = true;
    });
    
    downloader['checkTimeouts']();
    
    expect(retried).toBe(true);
    expect(downloader['queue'].has('block1')).toBe(true);
  });
  
  it('should respect max retries', () => {
    // add request that already failed max times
    downloader['inFlight'].set('block1', {
      hash: 'block1',
      peerId: 'peer1',
      timestamp: Date.now() - 2000,
      retries: 3 // max retries
    });
    
    let failed = false;
    downloader.on('block:failed', () => {
      failed = true;
    });
    
    downloader['checkTimeouts']();
    
    expect(failed).toBe(true);
    expect(downloader['queue'].has('block1')).toBe(false);
  });
});

describe('inventory manager', () => {
  let inventoryManager: InventoryManager;
  let connectionManager: ConnectionManager;
  let protocol: Protocol;
  let blockchain: Blockchain;
  let mempool: Mempool;
  
  beforeEach(async () => {
    const storage = new MemoryAdapter();
    await storage.connect();
    
    const chainConfig = getChainConfig('devnet');
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    mempool = new Mempool(storage, chainConfig);
    
    connectionManager = new ConnectionManager({
      nodeId: 'test',
      tcpPort: 9400
    });
    protocol = new Protocol();
    
    inventoryManager = new InventoryManager({
      connectionManager,
      protocol,
      blockchain,
      mempool
    });
  });
  
  it('should track peer inventory', () => {
    const items = [
      { type: 2, hash: 'block1' },
      { type: 2, hash: 'block2' },
      { type: 1, hash: 'tx1' }
    ];
    
    inventoryManager.handleInv('peer1', items);
    
    expect(inventoryManager.peerHasBlock('peer1', 'block1')).toBe(true);
    expect(inventoryManager.peerHasBlock('peer1', 'block2')).toBe(true);
    expect(inventoryManager.peerHasTransaction('peer1', 'tx1')).toBe(true);
    expect(inventoryManager.peerHasBlock('peer1', 'block3')).toBe(false);
  });
  
  it('should find peers with specific items', () => {
    inventoryManager.handleInv('peer1', [{ type: 2, hash: 'block1' }]);
    inventoryManager.handleInv('peer2', [{ type: 2, hash: 'block1' }]);
    inventoryManager.handleInv('peer3', [{ type: 2, hash: 'block2' }]);
    
    const peersWithBlock1 = inventoryManager.getPeersWithBlock('block1');
    expect(peersWithBlock1).toContain('peer1');
    expect(peersWithBlock1).toContain('peer2');
    expect(peersWithBlock1).not.toContain('peer3');
  });
  
  it('should prevent duplicate announcements', () => {
    inventoryManager.announceBlock('block1');
    inventoryManager.announceBlock('block1'); // duplicate
    
    expect(inventoryManager['recentAnnouncements'].size).toBe(1);
  });
  
  it('should clean up disconnected peers', () => {
    inventoryManager.handleInv('peer1', [{ type: 2, hash: 'block1' }]);
    
    expect(inventoryManager.peerHasBlock('peer1', 'block1')).toBe(true);
    
    // simulate disconnection
    connectionManager.emit('peer:disconnected', 'peer1');
    
    expect(inventoryManager.peerHasBlock('peer1', 'block1')).toBe(false);
  });
});

describe('orphan pool', () => {
  let orphanPool: OrphanPool;
  let blockchain: Blockchain;
  
  beforeEach(async () => {
    const storage = new MemoryAdapter();
    await storage.connect();
    
    const chainConfig = getChainConfig('devnet');
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    orphanPool = new OrphanPool({
      blockchain,
      maxOrphans: 5,
      orphanExpiryTime: 1000
    });
  });
  
  it('should add orphan blocks', () => {
    const orphan: Block = {
      index: 100,
      hash: 'orphan1',
      previousHash: 'missing-parent',
      timestamp: Date.now(),
      transactions: [],
      miner: 'test',
      difficulty: 1,
      nonce: 0,
      merkleRoot: 'merkle'
    };
    
    const added = orphanPool.addOrphan(orphan, 'peer1');
    expect(added).toBe(true);
    expect(orphanPool.hasOrphan('orphan1')).toBe(true);
  });
  
  it('should find orphans by parent', () => {
    const orphan1: Block = {
      index: 100,
      hash: 'orphan1',
      previousHash: 'parent1',
      timestamp: Date.now(),
      transactions: [],
      miner: 'test',
      difficulty: 1,
      nonce: 0,
      merkleRoot: 'merkle'
    };
    
    const orphan2: Block = {
      index: 101,
      hash: 'orphan2',
      previousHash: 'parent1',
      timestamp: Date.now(),
      transactions: [],
      miner: 'test',
      difficulty: 1,
      nonce: 0,
      merkleRoot: 'merkle'
    };
    
    orphanPool.addOrphan(orphan1, 'peer1');
    orphanPool.addOrphan(orphan2, 'peer1');
    
    const orphans = orphanPool.getOrphansForParent('parent1');
    expect(orphans.length).toBe(2);
    expect(orphans.map(b => b.hash)).toContain('orphan1');
    expect(orphans.map(b => b.hash)).toContain('orphan2');
  });
  
  it('should evict oldest when full', () => {
    // add max orphans
    for (let i = 1; i <= 5; i++) {
      const orphan: Block = {
        index: i,
        hash: `orphan${i}`,
        previousHash: 'parent',
        timestamp: Date.now() + i, // different timestamps
        transactions: [],
        miner: 'test',
        difficulty: 1,
        nonce: 0,
        merkleRoot: 'merkle'
      };
      orphanPool.addOrphan(orphan, 'peer1');
    }
    
    expect(orphanPool.getStats().orphanCount).toBe(5);
    
    // add one more (should evict oldest)
    const newOrphan: Block = {
      index: 6,
      hash: 'orphan6',
      previousHash: 'parent',
      timestamp: Date.now() + 100,
      transactions: [],
      miner: 'test',
      difficulty: 1,
      nonce: 0,
      merkleRoot: 'merkle'
    };
    
    orphanPool.addOrphan(newOrphan, 'peer1');
    
    expect(orphanPool.getStats().orphanCount).toBe(5);
    expect(orphanPool.hasOrphan('orphan6')).toBe(true);
    expect(orphanPool.hasOrphan('orphan1')).toBe(false); // oldest evicted
  });
  
  it('should clean up expired orphans', async () => {
    const orphan: Block = {
      index: 100,
      hash: 'orphan1',
      previousHash: 'parent',
      timestamp: Date.now(),
      transactions: [],
      miner: 'test',
      difficulty: 1,
      nonce: 0,
      merkleRoot: 'merkle'
    };
    
    orphanPool.addOrphan(orphan, 'peer1');
    expect(orphanPool.hasOrphan('orphan1')).toBe(true);
    
    // wait for expiry
    await Bun.sleep(1100);
    
    orphanPool['cleanupExpired']();
    expect(orphanPool.hasOrphan('orphan1')).toBe(false);
  });
});

describe('transaction relay', () => {
  let txRelay: TransactionRelay;
  let mempool: Mempool;
  let connectionManager: ConnectionManager;
  let inventoryManager: InventoryManager;
  let protocol: Protocol;
  
  beforeEach(async () => {
    const storage = new MemoryAdapter();
    await storage.connect();
    
    const chainConfig = getChainConfig('devnet');
    mempool = new Mempool(storage, chainConfig);
    
    connectionManager = new ConnectionManager({
      nodeId: 'test',
      tcpPort: 9500
    });
    protocol = new Protocol();
    
    const blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    inventoryManager = new InventoryManager({
      connectionManager,
      protocol,
      blockchain,
      mempool
    });
    
    txRelay = new TransactionRelay({
      mempool,
      connectionManager,
      inventoryManager,
      protocol,
      maxRecentTxs: 100
    });
  });
  
  it('should relay new transactions', () => {
    const tx: Transaction = {
      hash: 'tx1',
      from: 'addr1',
      to: 'addr2',
      amount: 1000n,
      fee: 10n,
      nonce: 0,
      timestamp: Date.now(),
      signature: 'sig',
      publicKey: 'pub'
    };
    
    txRelay.relayTransaction(tx);
    
    expect(txRelay['recentTxs'].has('tx1')).toBe(true);
    expect(txRelay['relayQueue'].has(tx)).toBe(true);
  });
  
  it('should prevent duplicate relays', () => {
    const tx: Transaction = {
      hash: 'tx1',
      from: 'addr1',
      to: 'addr2',
      amount: 1000n,
      fee: 10n,
      nonce: 0,
      timestamp: Date.now(),
      signature: 'sig',
      publicKey: 'pub'
    };
    
    txRelay.relayTransaction(tx);
    txRelay.relayTransaction(tx); // duplicate
    
    expect(txRelay.getStats().recentTxCount).toBe(1);
  });
  
  it('should handle transaction requests', () => {
    const tx: Transaction = {
      hash: 'tx1',
      from: 'addr1',
      to: 'addr2',
      amount: 1000n,
      fee: 10n,
      nonce: 0,
      timestamp: Date.now(),
      signature: 'sig',
      publicKey: 'pub'
    };
    
    // add to mempool
    mempool['transactions'].set('tx1', tx);
    mempool.getTransaction = (hash: string) => {
      return hash === 'tx1' ? tx : null;
    };
    
    let sentTx = false;
    connectionManager.sendMessage = () => {
      sentTx = true;
      return true;
    };
    
    const items = [{ type: 1, hash: 'tx1' }];
    txRelay['handleGetData']('peer1', items);
    
    expect(sentTx).toBe(true);
  });
  
  it('should clean up old transactions', () => {
    // add old transaction
    const oldTimestamp = Date.now() - 700000; // 11+ minutes ago
    txRelay['recentTxs'].set('old-tx', oldTimestamp);
    
    // add recent transaction
    txRelay['recentTxs'].set('new-tx', Date.now());
    
    txRelay['cleanupRecentTxs']();
    
    expect(txRelay['recentTxs'].has('old-tx')).toBe(false);
    expect(txRelay['recentTxs'].has('new-tx')).toBe(true);
  });
});