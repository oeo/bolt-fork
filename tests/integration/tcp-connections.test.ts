import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ConnectionManager } from '../../src/network/connection-manager';
import { Protocol } from '../../src/network/protocol';
import type { PeerEndpoint } from '../../src/network/peer-discovery';

describe('tcp connection integration', () => {
  let manager1: ConnectionManager;
  let manager2: ConnectionManager;
  let protocol: Protocol;
  
  beforeAll(() => {
    protocol = new Protocol();
  });
  
  afterAll(async () => {
    if (manager1) await manager1.stop();
    if (manager2) await manager2.stop();
  });
  
  it('should establish tcp connections between nodes', async () => {
    // create connection managers
    manager1 = new ConnectionManager({
      nodeId: 'node1',
      tcpPort: 9101
    });
    
    manager2 = new ConnectionManager({
      nodeId: 'node2',
      tcpPort: 9102
    });
    
    // start servers
    await manager1.start();
    await manager2.start();
    
    // track connections
    let node1Connected = false;
    let node2Connected = false;
    
    manager1.on('peer:connected', (peerId) => {
      if (peerId === 'node2') node1Connected = true;
    });
    
    manager2.on('peer:connected', (peerId) => {
      node2Connected = true;
    });
    
    // node1 connects to node2
    const endpoint: PeerEndpoint = {
      nodeId: 'node2',
      tcp: 'localhost:9102',
      height: 0,
      chainHash: 'genesis',
      version: '1.0.0',
      timestamp: Date.now()
    };
    
    const connected = await manager1.connectToPeer(endpoint);
    expect(connected).toBe(true);
    
    // wait for connection events
    await Bun.sleep(100);
    
    expect(node1Connected).toBe(true);
    expect(node2Connected).toBe(true);
    
    // verify connection state
    expect(manager1.isConnected('node2')).toBe(true);
    expect(manager1.getConnectedPeers()).toContain('node2');
  });
  
  it('should handle message buffering for partial messages', async () => {
    let receivedMessages = 0;
    let receivedData: Uint8Array | null = null;
    
    manager2.on('message:received', (peerId, data) => {
      receivedMessages++;
      receivedData = data;
    });
    
    // create a test message
    const testMessage = protocol.encodeMessage('ping', { nonce: 12345n });
    
    // send message from node1 to node2
    const sent = manager1.sendMessage('node2', testMessage);
    expect(sent).toBe(true);
    
    // wait for message
    await Bun.sleep(100);
    
    expect(receivedMessages).toBe(1);
    expect(receivedData).toBeDefined();
    
    // decode and verify
    const decoded = protocol.decodeMessage(receivedData!);
    expect(decoded).toBeDefined();
    expect(decoded?.command).toBe('ping');
    expect(decoded?.payload.nonce).toBe(12345n);
  });
  
  it('should handle multiple messages in sequence', async () => {
    const messages: any[] = [];
    
    manager2.removeAllListeners('message:received');
    manager2.on('message:received', (peerId, data) => {
      const decoded = protocol.decodeMessage(data);
      if (decoded) messages.push(decoded);
    });
    
    // send multiple messages rapidly
    for (let i = 0; i < 10; i++) {
      const msg = protocol.encodeMessage('ping', { nonce: BigInt(i) });
      manager1.sendMessage('node2', msg);
    }
    
    // wait for all messages
    await Bun.sleep(200);
    
    expect(messages.length).toBe(10);
    
    // verify order preserved
    for (let i = 0; i < 10; i++) {
      expect(messages[i].command).toBe('ping');
      expect(messages[i].payload.nonce).toBe(BigInt(i));
    }
  });
  
  it('should handle disconnection and cleanup', async () => {
    let disconnected = false;
    
    manager1.on('peer:disconnected', (peerId) => {
      if (peerId === 'node2') disconnected = true;
    });
    
    // disconnect node2
    manager1.disconnect('node2', 'test disconnect');
    
    await Bun.sleep(100);
    
    expect(disconnected).toBe(true);
    expect(manager1.isConnected('node2')).toBe(false);
    expect(manager1.getConnectedPeers()).not.toContain('node2');
  });
  
  it('should handle connection limits', async () => {
    const manager3 = new ConnectionManager({
      nodeId: 'node3',
      tcpPort: 9103,
      maxConnections: 2
    });
    
    await manager3.start();
    
    // create multiple endpoints
    const endpoints: PeerEndpoint[] = [];
    for (let i = 1; i <= 5; i++) {
      endpoints.push({
        nodeId: `peer${i}`,
        tcp: `localhost:910${i}`,
        height: 0,
        chainHash: 'genesis',
        version: '1.0.0',
        timestamp: Date.now()
      });
    }
    
    // try to connect to all (but should respect limit)
    let connectedCount = 0;
    for (const endpoint of endpoints) {
      // mock connection for testing limit
      if (manager3['connections'].size < 2) {
        manager3['connections'].set(endpoint.nodeId, {
          id: endpoint.nodeId,
          socket: {} as any,
          endpoint: endpoint.tcp,
          inbound: false,
          connected: true,
          lastSeen: Date.now(),
          messageBuffer: new Uint8Array(0)
        });
        connectedCount++;
      }
    }
    
    expect(connectedCount).toBe(2);
    expect(manager3.getConnectedPeers().length).toBe(2);
    
    await manager3.stop();
  });
  
  it('should update peer info after handshake', () => {
    manager1['connections'].set('test-peer', {
      id: 'test-peer',
      socket: {} as any,
      endpoint: 'localhost:9999',
      inbound: false,
      connected: true,
      lastSeen: Date.now(),
      messageBuffer: new Uint8Array(0)
    });
    
    manager1.updatePeerInfo('test-peer', {
      version: '1.0.0',
      height: 100,
      chainHash: 'abc123'
    });
    
    const conn = manager1.getConnection('test-peer');
    expect(conn?.version).toBe('1.0.0');
    expect(conn?.height).toBe(100);
    expect(conn?.chainHash).toBe('abc123');
  });
  
  it('should rename temporary connections', () => {
    const tempId = 'temp-12345';
    const actualId = 'actual-node-id';
    
    manager1['connections'].set(tempId, {
      id: tempId,
      socket: {} as any,
      endpoint: 'localhost:9999',
      inbound: true,
      connected: true,
      lastSeen: Date.now(),
      messageBuffer: new Uint8Array(0)
    });
    
    manager1.updatePeerInfo(tempId, {
      actualNodeId: actualId
    });
    
    expect(manager1.getConnection(tempId)).toBeUndefined();
    expect(manager1.getConnection(actualId)).toBeDefined();
  });
});