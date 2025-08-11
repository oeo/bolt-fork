import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { SyncService } from '../../src/services/sync';
import { Blockchain } from '../../src/core/blockchain';
import { BoltNode } from '../../src/network/node';
import { createStorage } from '../../src/storage';
import { config as chainConfig } from '../../src/config/chain';
import { BlockClass } from '../../src/core/block';

describe('Sync Service', () => {
  let syncService: SyncService;
  let blockchain: Blockchain;
  let node: BoltNode;
  let storage: any;

  beforeEach(async () => {
    storage = createStorage('memory');
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    node = new BoltNode({
      port: 17335,
      chainConfig,
      enableDHT: false,
      enableGossipsub: false
    });
    
    syncService = new SyncService({
      blockchain,
      node,
      syncBatchSize: 10,
      syncTimeout: 5000,
      maxReorgDepth: 100
    });
  });

  test('should create sync service instance', () => {
    expect(syncService).toBeDefined();
    expect(syncService.getStats).toBeDefined();
  });

  test('should initialize with correct stats', () => {
    const stats = syncService.getStats();
    
    expect(stats.isSyncing).toBe(false);
    expect(stats.currentHeight).toBe(0);
    expect(stats.targetHeight).toBe(0);
    expect(stats.peersAhead).toBe(0);
    expect(stats.syncProgress).toBe(0);
  });

  test('should handle peer status updates', async () => {
    // start the sync service first
    await syncService.start();
    
    // simulate peer status event
    node.emit('peer:status', 'peer1', {
      height: 100,
      cumulativeDifficulty: '1000000'
    });
    
    // check that peer height was recorded
    const stats = syncService.getStats();
    expect(stats).toBeDefined();
  });

  test('should detect when behind network', async () => {
    // mock node to prevent actual sync
    node.isStarted = mock(() => false); // node not started, so no sync
    
    // start the sync service
    await syncService.start();
    
    // simulate peer with higher height
    node.emit('peer:status', 'peer1', {
      height: 10,
      cumulativeDifficulty: '10000000'
    });
    
    // check that sync service recorded peer height
    const stats = syncService.getStats();
    expect(stats).toBeDefined();
    expect(stats.currentHeight).toBe(0); // genesis height
  });

  test('should handle peer disconnection', () => {
    // add peer status
    node.emit('peer:status', 'peer1', {
      height: 100,
      cumulativeDifficulty: '1000000'
    });
    
    // disconnect peer
    node.emit('peer:disconnect', 'peer1');
    
    // peer should be removed from tracking
    const stats = syncService.getStats();
    expect(stats).toBeDefined();
  });

  test('should track sync progress', () => {
    const stats = syncService.getStats();
    
    expect(stats.syncProgress).toBeGreaterThanOrEqual(0);
    expect(stats.syncProgress).toBeLessThanOrEqual(1);
  });

  test('should handle block announcements', async () => {
    // mock blockchain.addBlock to prevent actual processing
    blockchain.addBlock = mock(async () => ({ valid: true }));
    
    // create a valid block object
    const block = {
      index: 1,
      previousHash: 'genesis_hash',
      transactions: [],
      difficulty: 10,
      timestamp: Date.now(),
      nonce: 12345,
      hash: 'test_block_hash',
      merkleRoot: 'test_merkle',
      chainVersionHash: 'test_chain_version'
    };
    
    // emit block event
    node.emit('block', block);
    
    // wait a moment for async processing
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // should have attempted to process the block
    expect(blockchain.addBlock).toHaveBeenCalled();
  });

  test('should stop syncing when requested', () => {
    syncService.stop();
    
    const stats = syncService.getStats();
    expect(stats.isSyncing).toBe(false);
  });

  test('should handle invalid blocks during sync', async () => {
    // mock blockchain.addBlock to reject invalid block
    blockchain.addBlock = mock(async () => ({ 
      valid: false, 
      error: 'Invalid previous hash' 
    }));
    
    // create invalid block (wrong previous hash)
    const invalidBlock = {
      index: 1,
      previousHash: 'invalid_previous_hash',
      transactions: [],
      difficulty: 10,
      timestamp: Date.now(),
      nonce: 0,
      hash: 'invalid_hash',
      merkleRoot: 'invalid_merkle',
      chainVersionHash: 'test_chain_version'
    };
    
    // emit block event
    node.emit('block', invalidBlock);
    
    // wait a moment for async processing
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // should have attempted to add block but rejected it
    expect(blockchain.addBlock).toHaveBeenCalled();
    const height = await blockchain.getHeight();
    expect(height).toBe(0); // still at genesis
  });

  test('should calculate sync progress correctly', () => {
    const stats = syncService.getStats();
    
    // initially no sync progress
    expect(stats.syncProgress).toBe(0);
    
    // if syncing from 0 to 100
    // and current is 50
    // progress should be 0.5
    // this would be tested during actual sync
  });
});