import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { NetworkSecurity } from '../../src/network/security';
import { BoltNode } from '../../src/network/node';
import { PeerManager } from '../../src/network/peer-manager';
import { config as chainConfig } from '../../src/config/chain';

describe('Network Security', () => {
  let security: NetworkSecurity;
  let node: BoltNode;
  let peerManager: PeerManager;

  beforeEach(() => {
    node = new BoltNode({
      port: 17337,
      chainConfig,
      enableDHT: false,
      enableGossipsub: false
    });
    
    peerManager = new PeerManager({
      node,
      maxPeers: 10
    });
    
    security = new NetworkSecurity({
      node,
      peerManager,
      maxMessagesPerSecond: 10,
      maxBytesPerSecond: 1000000, // 1MB/s
      maxPendingRequests: 5,
      maxMessageSize: 100000, // 100KB
      banThresholdScore: 3
    });
  });

  test('should create security instance', () => {
    expect(security).toBeDefined();
    expect(security.getStats).toBeDefined();
  });

  test('should initialize with zero stats', () => {
    const stats = security.getStats();
    
    expect(stats.totalMessagesBlocked).toBe(0);
    expect(stats.totalBytesBlocked).toBe(0);
    expect(stats.totalPeersBanned).toBe(0);
    expect(stats.activeRateLimits).toBe(0);
  });

  test('should initialize peer limits on connect', () => {
    node.emit('peer:connect', 'peer1');
    
    const status = security.getPeerSecurityStatus('peer1');
    expect(status).toBeDefined();
    expect(status?.messagesPerSecond).toBe(0);
    expect(status?.bytesPerSecond).toBe(0);
    expect(status?.violations).toBe(0);
  });

  test('should block oversized messages', () => {
    node.emit('peer:connect', 'peer1');
    
    // simulate large message
    node.emit('message:received', 'peer1', 'NEW_BLOCK', {}, 200000); // 200KB
    
    const stats = security.getStats();
    expect(stats.totalMessagesBlocked).toBe(1);
    expect(stats.totalBytesBlocked).toBe(200000);
  });

  test('should enforce message rate limits', () => {
    node.emit('peer:connect', 'peer1');
    
    // send many messages quickly
    for (let i = 0; i < 15; i++) {
      node.emit('message:received', 'peer1', 'PING', {}, 100);
    }
    
    const stats = security.getStats();
    expect(stats.totalMessagesBlocked).toBeGreaterThan(0);
  });

  test('should enforce bandwidth limits', () => {
    node.emit('peer:connect', 'peer1');
    
    // send data exceeding bandwidth limit
    node.emit('message:received', 'peer1', 'BLOCKS', { blocks: [] }, 2000000); // 2MB
    
    const stats = security.getStats();
    expect(stats.totalBytesBlocked).toBeGreaterThan(0);
  });

  test('should track pending requests', () => {
    node.emit('peer:connect', 'peer1');
    
    // send multiple requests
    for (let i = 0; i < 3; i++) {
      node.emit('message:sending', 'peer1', 'GET_BLOCKS', {}, 100);
    }
    
    const status = security.getPeerSecurityStatus('peer1');
    expect(status?.pendingRequests).toBe(3);
  });

  test('should validate message content', () => {
    node.emit('peer:connect', 'peer1');
    
    // invalid transaction (missing fields)
    node.emit('message:received', 'peer1', 'NEW_TX', { hash: 'abc' }, 100);
    
    const stats = security.getStats();
    expect(stats.totalMessagesBlocked).toBe(1);
  });

  test('should limit blocks per request', () => {
    node.emit('peer:connect', 'peer1');
    
    // request too many blocks
    const data = {
      startHeight: 0,
      endHeight: 1000 // exceeds maxBlocksPerRequest
    };
    
    node.emit('message:received', 'peer1', 'GET_BLOCKS', data, 100);
    
    const stats = security.getStats();
    expect(stats.totalMessagesBlocked).toBe(1);
  });

  test('should track violations', () => {
    node.emit('peer:connect', 'peer1');
    
    // cause multiple violations
    node.emit('message:received', 'peer1', 'INVALID', {}, 200000); // oversized
    node.emit('message:received', 'peer1', 'INVALID', {}, 200000); // oversized
    
    const status = security.getPeerSecurityStatus('peer1');
    expect(status?.violations).toBeGreaterThan(0);
  });

  test('should ban peer after threshold violations', () => {
    node.emit('peer:connect', 'peer1');
    
    let bannedPeerId: string | null = null;
    peerManager.banPeer = mock((peerId: string) => {
      bannedPeerId = peerId;
    });
    
    // cause enough violations to trigger ban
    for (let i = 0; i < 4; i++) {
      node.emit('message:received', 'peer1', 'INVALID', {}, 200000);
    }
    
    expect(bannedPeerId).toBe('peer1');
    
    const stats = security.getStats();
    expect(stats.totalPeersBanned).toBe(1);
  });

  test('should cleanup limits on disconnect', () => {
    node.emit('peer:connect', 'peer1');
    expect(security.getPeerSecurityStatus('peer1')).toBeDefined();
    
    node.emit('peer:disconnect', 'peer1');
    expect(security.getPeerSecurityStatus('peer1')).toBeNull();
  });

  test('should whitelist peer', () => {
    node.emit('peer:connect', 'peer1');
    
    // cause violations
    node.emit('message:received', 'peer1', 'INVALID', {}, 200000);
    node.emit('message:received', 'peer1', 'INVALID', {}, 200000);
    
    let status = security.getPeerSecurityStatus('peer1');
    expect(status?.violations).toBeGreaterThan(0);
    
    // whitelist peer
    security.whitelistPeer('peer1');
    
    status = security.getPeerSecurityStatus('peer1');
    expect(status?.violations).toBe(0);
  });

  test('should adjust security limits', () => {
    security.adjustLimits({
      maxMessagesPerSecond: 20,
      maxBytesPerSecond: 2000000
    });
    
    // limits should be updated (internal state)
    const stats = security.getStats();
    expect(stats).toBeDefined();
  });

  test('should detect flood attack', () => {
    // create security with lower flood threshold for testing
    const testSecurity = new NetworkSecurity({
      node,
      peerManager,
      maxMessagesPerSecond: 100,
      floodThreshold: 50 // lower threshold for testing
    });
    
    node.emit('peer:connect', 'peer1');
    
    let bannedPeerId: string | null = null;
    peerManager.banPeer = mock((peerId: string) => {
      bannedPeerId = peerId;
    });
    
    // simulate flood (more than threshold but within rate limit)
    for (let i = 0; i < 51; i++) {
      node.emit('message:received', 'peer1', 'SPAM', {}, 10);
    }
    
    // peer should be banned for flood
    expect(bannedPeerId).toBe('peer1');
  });
});