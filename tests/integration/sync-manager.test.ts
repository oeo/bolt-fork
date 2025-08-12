import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SyncManager, SyncState } from '../../src/network/sync-manager';
import { ConnectionManager } from '../../src/network/connection-manager';
import { Protocol } from '../../src/network/protocol';
import { PeerDiscoveryService } from '../../src/network/peer-discovery';
import { Blockchain } from '../../src/core/blockchain';
import { MemoryAdapter } from '../../src/storage/memory';
import { getChainConfig } from '../../src/config/chain';
import type { Block } from '../../src/core/block';

describe('sync manager integration', () => {
  let syncManager: SyncManager;
  let blockchain: Blockchain;
  let connectionManager: ConnectionManager;
  let protocol: Protocol;
  let discoveryService: PeerDiscoveryService;
  
  beforeEach(async () => {
    // create blockchain with memory storage
    const storage = new MemoryAdapter();
    await storage.connect();
    
    const chainConfig = getChainConfig('devnet');
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    // create network components
    protocol = new Protocol();
    
    connectionManager = new ConnectionManager({
      nodeId: 'test-node',
      tcpPort: 9200
    });
    
    discoveryService = new PeerDiscoveryService({
      nodeId: 'test-node',
      tcpHost: 'localhost',
      tcpPort: 9200
    });
    
    // create sync manager
    syncManager = new SyncManager({
      blockchain,
      connectionManager,
      protocol,
      discoveryService
    });
  });
  
  afterEach(async () => {
    await syncManager.stop();
    await connectionManager.stop();
    await discoveryService.stop();
  });
  
  it('should build block locator with exponential backoff', () => {
    // add some blocks to blockchain
    const blocks: Block[] = [];
    for (let i = 1; i <= 100; i++) {
      blocks.push({
        index: i,
        hash: `hash${i}`,
        previousHash: i > 0 ? `hash${i-1}` : '0',
        timestamp: Date.now(),
        transactions: [],
        miner: 'test',
        difficulty: 1,
        nonce: 0,
        merkleRoot: 'merkle'
      });
    }
    
    // mock blockchain methods
    blockchain.getHeight = () => 100;
    blockchain.getBlockByHeight = (height: number) => {
      if (height >= 0 && height <= 100) {
        return blocks[height] || { hash: 'genesis' };
      }
      return null;
    };
    
    // build locator
    const locator = syncManager['buildBlockLocator']();
    
    // should have exponential backoff
    expect(locator.length).toBeGreaterThan(10);
    expect(locator[0]).toBe('hash100'); // tip
    expect(locator[locator.length - 1]).toBe('genesis'); // genesis
    
    // verify exponential spacing
    let prevHeight = 100;
    let step = 1;
    for (let i = 1; i < Math.min(10, locator.length - 1); i++) {
      const expectedHeight = prevHeight - step;
      expect(locator[i]).toBe(`hash${expectedHeight}`);
      prevHeight = expectedHeight;
    }
  });
  
  it('should start sync when discovering higher peer', async () => {
    await syncManager.start();
    
    // simulate peer with higher chain
    const higherPeer = {
      nodeId: 'peer1',
      tcp: 'localhost:9201',
      height: 1000,
      chainHash: 'higher-chain',
      version: '1.0.0',
      timestamp: Date.now()
    };
    
    // mock connection
    connectionManager.isConnected = (nodeId: string) => false;
    connectionManager.connectToPeer = async () => true;
    
    let headerRequested = false;
    connectionManager.sendMessage = (nodeId: string, data: Uint8Array) => {
      const message = protocol.decodeMessage(data);
      if (message?.command === 'getheaders') {
        headerRequested = true;
      }
      return true;
    };
    
    // trigger sync check
    syncManager['checkIfSyncNeeded'](higherPeer);
    
    await Bun.sleep(100);
    
    expect(syncManager.getSyncStatus().state).toBe(SyncState.SYNCING_HEADERS);
    expect(headerRequested).toBe(true);
  });
  
  it('should handle headers response and queue blocks', async () => {
    // mock headers
    const headers = [
      { hash: 'block1', previousHash: 'genesis', merkleRoot: 'm1', timestamp: 1000, difficulty: 1, nonce: 0, height: 1 },
      { hash: 'block2', previousHash: 'block1', merkleRoot: 'm2', timestamp: 2000, difficulty: 1, nonce: 0, height: 2 },
      { hash: 'block3', previousHash: 'block2', merkleRoot: 'm3', timestamp: 3000, difficulty: 1, nonce: 0, height: 3 }
    ];
    
    // mock blockchain has no blocks
    blockchain.getBlockByHash = () => null;
    
    let getDataRequested = false;
    connectionManager.sendMessage = (nodeId: string, data: Uint8Array) => {
      const message = protocol.decodeMessage(data);
      if (message?.command === 'getdata') {
        getDataRequested = true;
      }
      return true;
    };
    
    // handle headers
    await syncManager['handleHeaders']('peer1', headers);
    
    // should have queued missing blocks
    expect(syncManager['missingBlocks'].size).toBe(3);
    expect(syncManager.getSyncStatus().state).toBe(SyncState.SYNCING_BLOCKS);
    
    // should request blocks
    await Bun.sleep(100);
    expect(getDataRequested).toBe(true);
  });
  
  it('should handle version handshake', () => {
    let verackSent = false;
    connectionManager.sendMessage = (nodeId: string, data: Uint8Array) => {
      const message = protocol.decodeMessage(data);
      if (message?.command === 'verack') {
        verackSent = true;
      }
      return true;
    };
    
    connectionManager.updatePeerInfo = jest.fn();
    
    const version = {
      version: 1,
      services: 1n,
      timestamp: Date.now(),
      addrRecv: 'peer',
      addrFrom: 'self',
      nonce: 12345n,
      userAgent: 'test/1.0',
      startHeight: 500
    };
    
    syncManager['handleVersion']('peer1', version);
    
    expect(verackSent).toBe(true);
    expect(connectionManager.updatePeerInfo).toHaveBeenCalledWith('peer1', {
      version: 'test/1.0',
      height: 500
    });
  });
  
  it('should handle ping/pong', () => {
    let pongSent = false;
    let pongNonce: bigint | null = null;
    
    connectionManager.sendMessage = (nodeId: string, data: Uint8Array) => {
      const message = protocol.decodeMessage(data);
      if (message?.command === 'pong') {
        pongSent = true;
        pongNonce = message.payload.nonce;
      }
      return true;
    };
    
    syncManager['handlePing']('peer1', { nonce: 99999n });
    
    expect(pongSent).toBe(true);
    expect(pongNonce).toBe(99999n);
  });
  
  it('should handle inventory announcements', () => {
    const items = [
      { type: 2, hash: 'newblock1' }, // block
      { type: 2, hash: 'newblock2' }, // block
      { type: 1, hash: 'tx1' } // transaction (ignored for now)
    ];
    
    // mock blockchain doesn't have these blocks
    blockchain.getBlockByHash = () => null;
    
    let requestedItems: any[] = [];
    connectionManager.sendMessage = (nodeId: string, data: Uint8Array) => {
      const message = protocol.decodeMessage(data);
      if (message?.command === 'getdata') {
        requestedItems = message.payload;
      }
      return true;
    };
    
    syncManager['handleInv']('peer1', items);
    
    // should request only blocks we don't have
    expect(requestedItems.length).toBe(2);
    expect(requestedItems[0].hash).toBe('newblock1');
    expect(requestedItems[1].hash).toBe('newblock2');
  });
  
  it('should track sync progress', async () => {
    const status = syncManager.getSyncStatus();
    
    expect(status.state).toBe(SyncState.IDLE);
    expect(status.currentHeight).toBe(0);
    expect(status.headersReceived).toBe(0);
    expect(status.blocksToDownload).toBe(0);
    
    // simulate sync
    syncManager['syncState'] = SyncState.SYNCING_HEADERS;
    syncManager['syncTarget'] = {
      nodeId: 'peer1',
      tcp: 'localhost:9201',
      height: 1000,
      chainHash: 'target',
      version: '1.0.0',
      timestamp: Date.now()
    };
    
    // add some headers
    syncManager['headerChain'].set(1, {} as any);
    syncManager['headerChain'].set(2, {} as any);
    
    // add missing blocks
    syncManager['missingBlocks'].add('block1');
    syncManager['missingBlocks'].add('block2');
    syncManager['missingBlocks'].add('block3');
    
    const updatedStatus = syncManager.getSyncStatus();
    
    expect(updatedStatus.state).toBe(SyncState.SYNCING_HEADERS);
    expect(updatedStatus.targetHeight).toBe(1000);
    expect(updatedStatus.headersReceived).toBe(2);
    expect(updatedStatus.blocksToDownload).toBe(3);
  });
});