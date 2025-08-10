import { describe, test, expect, beforeEach } from 'bun:test';
import { PeerManager } from '../../src/network/peer-manager';
import { BoltNode } from '../../src/network/node';
import { config as chainConfig } from '../../src/config/chain';

describe('Peer Manager', () => {
  let peerManager: PeerManager;
  let node: BoltNode;

  beforeEach(() => {
    node = new BoltNode({
      port: 17336,
      chainConfig,
      enableDHT: false,
      enableGossipsub: false
    });
    
    peerManager = new PeerManager({
      node,
      maxPeers: 10,
      minPeers: 2,
      scoreDecayInterval: 1000,
      banDuration: 5000,
      maxInvalidMessages: 3,
      preferredPeers: ['preferred-peer-1']
    });
  });

  test('should create peer manager instance', () => {
    expect(peerManager).toBeDefined();
    expect(peerManager.getStats).toBeDefined();
    expect(peerManager.getPeers).toBeDefined();
  });

  test('should start with empty peer list', () => {
    const peers = peerManager.getPeers();
    expect(peers).toEqual([]);
    
    const stats = peerManager.getStats();
    expect(stats.totalPeers).toBe(0);
    expect(stats.activePeers).toBe(0);
    expect(stats.bannedPeers).toBe(0);
  });

  test('should add peer on connect event', () => {
    // simulate peer connection
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    const peers = peerManager.getPeers();
    expect(peers.length).toBe(1);
    expect(peers[0].id).toBe('peer1');
    expect(peers[0].address).toBe('/ip4/127.0.0.1/tcp/7334');
    expect(peers[0].banned).toBe(false);
    expect(peers[0].score).toBe(50); // default score
  });

  test('should give preferred peers higher initial score', () => {
    // connect preferred peer
    node.emit('peer:connect', 'preferred-peer-1', '/ip4/127.0.0.1/tcp/7334');
    
    const peer = peerManager.getPeer('preferred-peer-1');
    expect(peer).toBeDefined();
    expect(peer?.score).toBe(100); // preferred peer score
  });

  test('should update peer status', () => {
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    // update status
    node.emit('peer:status', 'peer1', {
      height: 100,
      difficulty: '1000000',
      version: '1.0.0',
      services: ['full_node']
    });
    
    const peer = peerManager.getPeer('peer1');
    expect(peer?.height).toBe(100);
    expect(peer?.version).toBe('1.0.0');
    expect(peer?.services).toEqual(['full_node']);
    expect(peer?.score).toBeGreaterThan(50); // score increased
  });

  test('should track peer metrics', () => {
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    // simulate messages
    node.emit('peer:message', 'peer1', 'block', 1000, 'in');
    node.emit('peer:message', 'peer1', 'tx', 500, 'out');
    
    const peer = peerManager.getPeer('peer1');
    expect(peer?.bytesReceived).toBe(1000);
    expect(peer?.bytesSent).toBe(500);
    expect(peer?.messagesReceived).toBe(1);
    expect(peer?.messagesSent).toBe(1);
  });

  test('should handle invalid messages', () => {
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    const initialScore = peerManager.getPeer('peer1')?.score || 0;
    
    // send invalid message
    node.emit('peer:invalid', 'peer1', 'Invalid block hash');
    
    const peer = peerManager.getPeer('peer1');
    expect(peer?.invalidMessages).toBe(1);
    expect(peer?.score).toBeLessThan(initialScore);
  });

  test('should ban peer after too many invalid messages', () => {
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    // send multiple invalid messages
    node.emit('peer:invalid', 'peer1', 'Invalid 1');
    node.emit('peer:invalid', 'peer1', 'Invalid 2');
    node.emit('peer:invalid', 'peer1', 'Invalid 3');
    
    const peer = peerManager.getPeer('peer1');
    expect(peer?.banned).toBe(true);
    expect(peer?.banReason).toContain('Too many invalid messages');
    expect(peer?.score).toBe(0);
  });

  test('should not ban preferred peers', () => {
    node.emit('peer:connect', 'preferred-peer-1', '/ip4/127.0.0.1/tcp/7334');
    
    // try to ban preferred peer
    peerManager.banPeer('preferred-peer-1', 'Test ban');
    
    const peer = peerManager.getPeer('preferred-peer-1');
    expect(peer?.banned).toBe(false);
  });

  test('should adjust peer score', () => {
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    const initialScore = peerManager.getPeer('peer1')?.score || 0;
    
    // increase score
    peerManager.adjustScore('peer1', 10);
    expect(peerManager.getPeer('peer1')?.score).toBe(initialScore + 10);
    
    // decrease score
    peerManager.adjustScore('peer1', -5);
    expect(peerManager.getPeer('peer1')?.score).toBe(initialScore + 5);
  });

  test('should get best peers by score', () => {
    // add multiple peers
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    node.emit('peer:connect', 'peer2', '/ip4/127.0.0.1/tcp/7335');
    node.emit('peer:connect', 'peer3', '/ip4/127.0.0.1/tcp/7336');
    
    // adjust scores
    peerManager.adjustScore('peer1', 20);
    peerManager.adjustScore('peer2', -10);
    peerManager.adjustScore('peer3', 10);
    
    const bestPeers = peerManager.getBestPeers(2);
    expect(bestPeers.length).toBe(2);
    expect(bestPeers[0].id).toBe('peer1'); // highest score
    expect(bestPeers[1].id).toBe('peer3'); // second highest
  });

  test('should track connection count', () => {
    // connect peer
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    expect(peerManager.getPeer('peer1')?.connectionCount).toBe(1);
    
    // disconnect and reconnect
    node.emit('peer:disconnect', 'peer1');
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    expect(peerManager.getPeer('peer1')?.connectionCount).toBe(2);
  });

  test('should get active peers only', () => {
    // add multiple peers
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    node.emit('peer:connect', 'peer2', '/ip4/127.0.0.1/tcp/7335');
    node.emit('peer:connect', 'peer3', '/ip4/127.0.0.1/tcp/7336');
    
    // ban one peer
    peerManager.banPeer('peer2', 'Test ban');
    
    const activePeers = peerManager.getActivePeers();
    expect(activePeers.length).toBe(2);
    expect(activePeers.find(p => p.id === 'peer2')).toBeUndefined();
  });

  test('should calculate statistics correctly', () => {
    // add peers
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    node.emit('peer:connect', 'peer2', '/ip4/127.0.0.1/tcp/7335');
    
    // add some metrics
    node.emit('peer:message', 'peer1', 'block', 1000, 'in');
    node.emit('peer:message', 'peer2', 'tx', 500, 'in');
    
    // ban one peer
    peerManager.banPeer('peer2', 'Test');
    
    const stats = peerManager.getStats();
    expect(stats.totalPeers).toBe(2);
    expect(stats.activePeers).toBe(1);
    expect(stats.bannedPeers).toBe(1);
    expect(stats.totalBytesReceived).toBe(1500);
    expect(stats.averageScore).toBeGreaterThan(0);
  });

  test('should unban peer', () => {
    node.emit('peer:connect', 'peer1', '/ip4/127.0.0.1/tcp/7334');
    
    // ban and then unban
    peerManager.banPeer('peer1', 'Test ban');
    expect(peerManager.getPeer('peer1')?.banned).toBe(true);
    
    peerManager.unbanPeer('peer1');
    expect(peerManager.getPeer('peer1')?.banned).toBe(false);
    expect(peerManager.getPeer('peer1')?.score).toBe(25); // low score after unban
  });
});