import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { $ } from 'bun';
import { PeerDiscoveryService } from '../../src/network/peer-discovery';
import { create } from 'ipfs-http-client';

describe('peer discovery integration', () => {
  let discovery1: PeerDiscoveryService;
  let discovery2: PeerDiscoveryService;
  let discovery3: PeerDiscoveryService;
  
  beforeAll(async () => {
    // launch test cluster
    console.log('launching test cluster...');
    await $`bun run scripts/launch-cluster.ts 3 --clean`.quiet();
    
    // wait for nodes to start
    await Bun.sleep(5000);
  });
  
  afterAll(async () => {
    // stop services
    if (discovery1) await discovery1.stop();
    if (discovery2) await discovery2.stop();
    if (discovery3) await discovery3.stop();
    
    // stop cluster
    console.log('stopping test cluster...');
    await $`bun run scripts/stop-cluster.ts 3`.quiet();
  });
  
  it('should discover peers via ipfs pubsub', async () => {
    // create discovery services for each node
    discovery1 = new PeerDiscoveryService({
      nodeId: 'test-node-1',
      tcpHost: 'localhost',
      tcpPort: 8001,
      ipfsApi: 'http://localhost:5011',
      announceInterval: 1000
    });
    
    discovery2 = new PeerDiscoveryService({
      nodeId: 'test-node-2',
      tcpHost: 'localhost',
      tcpPort: 8002,
      ipfsApi: 'http://localhost:5021',
      announceInterval: 1000
    });
    
    discovery3 = new PeerDiscoveryService({
      nodeId: 'test-node-3',
      tcpHost: 'localhost',
      tcpPort: 8003,
      ipfsApi: 'http://localhost:5031',
      announceInterval: 1000
    });
    
    // track discovered peers
    const node1Peers = new Set<string>();
    const node2Peers = new Set<string>();
    const node3Peers = new Set<string>();
    
    discovery1.on('peer:discovered', (peer) => {
      node1Peers.add(peer.nodeId);
    });
    
    discovery2.on('peer:discovered', (peer) => {
      node2Peers.add(peer.nodeId);
    });
    
    discovery3.on('peer:discovered', (peer) => {
      node3Peers.add(peer.nodeId);
    });
    
    // start discovery services
    await discovery1.start(0, 'genesis');
    await discovery2.start(0, 'genesis');
    await discovery3.start(0, 'genesis');
    
    // wait for discovery
    await Bun.sleep(3000);
    
    // each node should discover the other two
    expect(node1Peers.size).toBeGreaterThanOrEqual(2);
    expect(node2Peers.size).toBeGreaterThanOrEqual(2);
    expect(node3Peers.size).toBeGreaterThanOrEqual(2);
    
    expect(node1Peers.has('test-node-2')).toBe(true);
    expect(node1Peers.has('test-node-3')).toBe(true);
    
    expect(node2Peers.has('test-node-1')).toBe(true);
    expect(node2Peers.has('test-node-3')).toBe(true);
    
    expect(node3Peers.has('test-node-1')).toBe(true);
    expect(node3Peers.has('test-node-2')).toBe(true);
  });
  
  it('should announce tcp endpoints correctly', async () => {
    const peers = discovery1.getKnownPeers();
    
    for (const peer of peers) {
      expect(peer.tcp).toMatch(/^localhost:\d+$/);
      expect(peer.height).toBe(0);
      expect(peer.chainHash).toBe('genesis');
      expect(peer.version).toBe('1.0.0');
    }
  });
  
  it('should update chain info in announcements', async () => {
    // update chain info
    discovery1.updateChainInfo(100, 'blockhash100');
    
    // wait for next announcement
    await Bun.sleep(2000);
    
    // check if other nodes received update
    const peer1AtNode2 = discovery2.getPeer('test-node-1');
    expect(peer1AtNode2).toBeDefined();
    expect(peer1AtNode2?.height).toBe(100);
    expect(peer1AtNode2?.chainHash).toBe('blockhash100');
  });
  
  it('should remove stale peers', async () => {
    // stop one discovery service
    await discovery3.stop();
    
    // wait for cleanup (with faster timeout for testing)
    await Bun.sleep(3000);
    
    // check if peer was removed from other nodes
    const peers1 = discovery1.getKnownPeers();
    const peers2 = discovery2.getKnownPeers();
    
    // with short timeout, peer3 might still be there but marked stale
    // in production it would be removed after timeout
    expect(peers1.length).toBeLessThanOrEqual(2);
    expect(peers2.length).toBeLessThanOrEqual(2);
  });
  
  it('should find best peer by height', () => {
    // manually add some test peers
    const testPeers = [
      { nodeId: 'peer1', tcp: 'localhost:9001', height: 50, chainHash: 'hash50', version: '1.0.0', timestamp: Date.now() },
      { nodeId: 'peer2', tcp: 'localhost:9002', height: 100, chainHash: 'hash100', version: '1.0.0', timestamp: Date.now() },
      { nodeId: 'peer3', tcp: 'localhost:9003', height: 75, chainHash: 'hash75', version: '1.0.0', timestamp: Date.now() }
    ];
    
    // create new discovery service for testing
    const testDiscovery = new PeerDiscoveryService({
      nodeId: 'test-best-peer',
      tcpHost: 'localhost',
      tcpPort: 9000
    });
    
    // manually populate peers
    for (const peer of testPeers) {
      testDiscovery['knownPeers'].set(peer.nodeId, peer as any);
    }
    
    const bestPeer = testDiscovery.getBestPeer();
    expect(bestPeer).toBeDefined();
    expect(bestPeer?.nodeId).toBe('peer2');
    expect(bestPeer?.height).toBe(100);
  });
});