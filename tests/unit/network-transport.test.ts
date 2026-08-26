import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { ConnectionManager } from '../../src/network/connection-manager';
import {
  MessageType,
  PROTOCOL_HEADER_SIZE,
  Protocol
} from '../../src/network/protocol';
import { SyncManager } from '../../src/network/sync-manager';
import { PeerDiscoveryService } from '../../src/network/peer-discovery';
import { parsePeerEndpoint } from '../../src/network/peer-discovery';
import { TransactionRelay } from '../../src/network/transaction-relay';
import { generateAddress } from '../../src/crypto/address';
import { sign } from '../../src/crypto/signature';
import { mainnet } from '../../src/config/chains/mainnet';
import type { NodeIdentity } from '../../src/utils/identity';

const genesisHash = 'ab'.repeat(32);

function createProtocol(maxPayloadSize = 1024): Protocol {
  return new Protocol({ chainId: mainnet.chainId, genesisHash, maxPayloadSize });
}

function createIdentity(): NodeIdentity {
  return { ...generateAddress(mainnet.addressPrefix), createdAt: Date.now() };
}

function createSocket(write?: (data: Uint8Array) => number): any {
  return {
    remoteAddress: '127.0.0.1',
    writes: [] as Uint8Array[],
    closed: false,
    write(data: Uint8Array) {
      this.writes.push(data.slice());
      return write ? write(data) : data.length;
    },
    end() { this.closed = true; },
    terminate() { this.closed = true; }
  };
}

function createManager(nodeId: string, protocol: Protocol, overrides: Record<string, unknown> = {}): ConnectionManager {
  const manager = new ConnectionManager({
    nodeId,
    tcpPort: 0,
    protocol,
    maxMessageSize: 1024,
    maxBufferedBytes: 1080,
    ...overrides
  });
  (manager as any).isRunning = true;
  return manager;
}

function admit(manager: ConnectionManager, socket: any, inbound = true, expectedPeerId?: string): string {
  (manager as any).handleNewConnection(socket, inbound, expectedPeerId);
  const sessions = [...(manager as any).connections.keys()];
  return sessions[sessions.length - 1];
}

describe('connection manager transport', () => {
  it('extracts authenticated fragmented and coalesced frames', () => {
    const protocol = createProtocol();
    const local = createIdentity();
    const remote = createIdentity();
    const manager = createManager(local.address, protocol);
    const socket = createSocket();
    const sessionId = admit(manager, socket);
    const key = new Uint8Array(32).fill(7);
    expect(manager.setSessionKeys(sessionId, key, key)).toBe(true);
    expect(manager.bindPeerIdentity(sessionId, remote.address)).toBe(true);

    const received: Uint8Array[] = [];
    manager.on('message:received', (_peerId, message) => received.push(message));
    const messages = [1n, 2n, 3n].map((nonce, index) => protocol.authenticateMessage(
      protocol.encodeMessage('ping', { nonce }),
      key,
      BigInt(index + 1)
    ));
    const combined = new Uint8Array(messages[0].length + messages[1].length + 10);
    combined.set(messages[0]);
    combined.set(messages[1], messages[0].length);
    combined.set(messages[2].subarray(0, 10), messages[0].length + messages[1].length);

    for (let split = 0; split < messages[0].length; split += 7) {
      (manager as any).handleData(socket, messages[0].subarray(split, split + 7));
    }
    expect(received).toHaveLength(1);

    const secondManager = createManager(local.address, protocol);
    const secondSocket = createSocket();
    const secondSession = admit(secondManager, secondSocket);
    secondManager.setSessionKeys(secondSession, key, key);
    secondManager.bindPeerIdentity(secondSession, remote.address);
    const coalesced: Uint8Array[] = [];
    secondManager.on('message:received', (_peerId, message) => coalesced.push(message));
    (secondManager as any).handleData(secondSocket, combined);
    expect(coalesced).toHaveLength(2);
    (secondManager as any).handleData(secondSocket, messages[2].subarray(10));
    expect(coalesced).toHaveLength(3);
  });

  it('rejects oversized declarations before buffering payloads', () => {
    const protocol = createProtocol(32);
    const manager = createManager(createIdentity().address, protocol, {
      maxMessageSize: 32,
      maxBufferedBytes: 32 + PROTOCOL_HEADER_SIZE
    });
    const socket = createSocket();
    admit(manager, socket);
    const header = new Uint8Array(PROTOCOL_HEADER_SIZE);
    const view = new DataView(header.buffer);
    view.setUint32(0, protocol.networkMagic, false);
    view.setUint32(4, MessageType.VERSION, false);
    view.setUint32(8, 33, false);

    (manager as any).handleData(socket, header);
    expect(socket.closed).toBe(true);
    expect(manager.getStats().totalConnections).toBe(0);
  });

  it('rejects application traffic before authentication', () => {
    const protocol = createProtocol();
    const manager = createManager(createIdentity().address, protocol);
    const socket = createSocket();
    admit(manager, socket);

    (manager as any).handleData(socket, protocol.encodeMessage('ping', { nonce: 1n }));
    expect(socket.closed).toBe(true);
  });

  it('enforces aggregate inbound connection limits', () => {
    const protocol = createProtocol();
    const manager = createManager(createIdentity().address, protocol, {
      maxConnections: 1,
      maxInboundConnections: 1
    });
    const first = createSocket();
    const second = createSocket();
    admit(manager, first);
    (manager as any).handleNewConnection(second, true);

    expect(first.closed).toBe(false);
    expect(second.closed).toBe(true);
    expect(manager.getStats().totalConnections).toBe(1);
  });

  it('limits unauthenticated connections and attempts per source address', () => {
    const protocol = createProtocol();
    const manager = createManager(createIdentity().address, protocol, {
      maxUnauthenticatedPerAddress: 1,
      maxInboundAttemptsPerMinute: 3
    });
    const first = createSocket();
    const second = createSocket();
    const third = createSocket();
    admit(manager, first);
    (manager as any).handleNewConnection(second, true);
    manager.disconnect([...((manager as any).connections.keys())][0]);
    (manager as any).handleNewConnection(third, true);

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(third.closed).toBe(false);
    const fourth = createSocket();
    manager.disconnect([...((manager as any).connections.keys())][0]);
    (manager as any).handleNewConnection(fourth, true);
    expect(fourth.closed).toBe(true);
  });

  it('rejects private addresses in mapped and compressed IPv6 forms', () => {
    const manager = createManager(createIdentity().address, createProtocol());

    expect((manager as any).isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect((manager as any).isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect((manager as any).isPrivateAddress('fd00::1')).toBe(true);
    expect((manager as any).isPrivateAddress('2001:db8::1')).toBe(true);
    expect((manager as any).isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('bounds pending dials and rejects stale opens without clearing current markers', async () => {
    const local = createIdentity();
    const remote = createIdentity();
    const manager = createManager(local.address, createProtocol(), { maxPendingConnections: 2 });
    const endpoint = {
      nodeId: remote.address,
      publicKey: remote.publicKey,
      tcp: '1.1.1.1:8333',
      height: 0,
      tipHash: genesisHash,
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      lastSeen: Date.now(),
      capabilities: [],
      signature: 'ab'.repeat(64)
    };
    const calls: Array<{ options: any; resolve: (socket: any) => void }> = [];
    const originalConnect = Bun.connect;
    (Bun as any).connect = (options: any) => new Promise(resolve => calls.push({ options, resolve }));

    try {
      const first = manager.connectToPeer(endpoint);
      while (calls.length < 1) await Bun.sleep(1);

      await manager.stop();
      (manager as any).isRunning = true;
      (manager as any).runGeneration++;
      const second = manager.connectToPeer(endpoint);
      while (calls.length < 2) await Bun.sleep(1);

      const staleSocket = { ...createSocket(), remoteAddress: '1.1.1.1' };
      calls[0].options.socket.open(staleSocket);
      calls[0].resolve(staleSocket);
      expect(await first).toBe(false);
      expect(staleSocket.closed).toBe(true);
      expect((manager as any).pendingPeers.has(remote.address)).toBe(true);
      expect((manager as any).pendingEndpoints.has('1.1.1.1:8333')).toBe(true);

      const currentSocket = { ...createSocket(), remoteAddress: '1.1.1.1' };
      calls[1].options.socket.open(currentSocket);
      calls[1].resolve(currentSocket);
      expect(await second).toBe(true);
      expect(currentSocket.closed).toBe(false);
    } finally {
      (Bun as any).connect = originalConnect;
      await manager.stop();
    }
  });

  it('retains timed-out native dial slots until late settlement', async () => {
    const local = createIdentity();
    const remote = createIdentity();
    const manager = createManager(local.address, createProtocol(), {
      connectionTimeout: 5,
      maxPendingConnections: 1
    });
    const endpoint = {
      nodeId: remote.address,
      publicKey: remote.publicKey,
      tcp: '1.1.1.1:8333',
      height: 0,
      tipHash: genesisHash,
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      lastSeen: Date.now(),
      capabilities: [],
      signature: 'ab'.repeat(64)
    };
    let options: any;
    let resolveDial!: (socket: any) => void;
    const originalConnect = Bun.connect;
    (Bun as any).connect = (dialOptions: any) => {
      options = dialOptions;
      return new Promise(resolve => { resolveDial = resolve; });
    };

    try {
      expect(await manager.connectToPeer(endpoint)).toBe(false);
      expect((manager as any).pendingPeers.size).toBe(1);
      expect(await manager.connectToPeer({ ...endpoint, nodeId: createIdentity().address })).toBe(false);
      await manager.stop();
      (manager as any).isRunning = true;
      (manager as any).runGeneration++;
      expect(await manager.connectToPeer({ ...endpoint, nodeId: createIdentity().address })).toBe(false);

      const socket = { ...createSocket(), remoteAddress: '1.1.1.1' };
      options.socket.open(socket);
      resolveDial(socket);
      await Bun.sleep(0);
      expect(socket.closed).toBe(true);
      expect((manager as any).pendingPeers.size).toBe(0);
    } finally {
      (Bun as any).connect = originalConnect;
      await manager.stop();
    }
  });

  it('reserves outbound capacity before dns resolution', async () => {
    const local = createIdentity();
    const remote = createIdentity();
    const manager = createManager(local.address, createProtocol(), { maxPendingConnections: 1 });
    const endpoint = {
      nodeId: remote.address,
      publicKey: remote.publicKey,
      tcp: 'peer.example:8333',
      height: 0,
      tipHash: genesisHash,
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      lastSeen: Date.now(),
      capabilities: [],
      signature: 'ab'.repeat(64)
    };
    let releaseDns!: () => void;
    const dnsBlocked = new Promise<void>(resolve => { releaseDns = resolve; });
    (manager as any).resolveHost = async () => {
      await dnsBlocked;
      return [{ address: '1.1.1.1' }];
    };
    let nativeDials = 0;
    const originalConnect = Bun.connect;
    (Bun as any).connect = async (options: any) => {
      nativeDials++;
      const socket = { ...createSocket(), remoteAddress: '1.1.1.1' };
      options.socket.open(socket);
      return socket;
    };

    try {
      const first = manager.connectToPeer(endpoint);
      await Bun.sleep(0);
      expect((manager as any).nativeAttempts.size).toBe(1);
      expect(await manager.connectToPeer({ ...endpoint, nodeId: createIdentity().address })).toBe(false);
      expect(nativeDials).toBe(0);

      releaseDns();
      expect(await first).toBe(true);
      expect(nativeDials).toBe(1);
    } finally {
      (Bun as any).connect = originalConnect;
      await manager.stop();
    }
  });

  it('sends keepalives before authenticated peers become idle', () => {
    const protocol = createProtocol();
    const local = createIdentity();
    const remote = createIdentity();
    const manager = createManager(local.address, protocol, { messageTimeout: 60000 });
    const socket = createSocket();
    const sessionId = admit(manager, socket);
    const key = new Uint8Array(32).fill(4);
    manager.setSessionKeys(sessionId, key, key);
    manager.bindPeerIdentity(sessionId, remote.address);
    const now = Date.now();
    manager.getConnection(sessionId)!.lastSeen = now - 31000;

    (manager as any).checkConnectionHealth(now);

    expect(socket.writes).toHaveLength(1);
    expect(protocol.decodeMessage(socket.writes[0])?.command).toBe('ping');
    expect(manager.isAuthenticated(remote.address)).toBe(true);
  });

  it('deduplicates outbound dials and cools down failed endpoints', async () => {
    const protocol = createProtocol();
    const local = createIdentity();
    const remote = createIdentity();
    const manager = createManager(local.address, protocol, { allowPrivatePeers: true });
    (manager as any).handleNewConnection(createSocket(), false, remote.address, '127.0.0.1:8333');
    const sessionId = [...(manager as any).connections.keys()][0];

    expect(await manager.connectToPeer({
      nodeId: remote.address,
      publicKey: remote.publicKey,
      tcp: '127.0.0.1:8333',
      height: 0,
      tipHash: genesisHash,
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      lastSeen: Date.now(),
      capabilities: [],
      signature: 'ab'.repeat(64)
    })).toBe(false);

    manager.disconnect(sessionId, 'handshake failed');
    expect(await manager.connectToPeer({
      nodeId: remote.address,
      publicKey: remote.publicKey,
      tcp: '127.0.0.1:8333',
      height: 0,
      tipHash: genesisHash,
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      lastSeen: Date.now(),
      capabilities: [],
      signature: 'ab'.repeat(64)
    })).toBe(false);
  });

  it('rate limits endpoint attempts across peer identities', () => {
    const manager = createManager(createIdentity().address, createProtocol(), {
      maxEndpointAttemptsPerMinute: 2
    });

    expect((manager as any).allowEndpointAttempt('203.0.113.1:8333')).toBe(true);
    expect((manager as any).allowEndpointAttempt('203.0.113.1:8333')).toBe(true);
    expect((manager as any).allowEndpointAttempt('203.0.113.1:8333')).toBe(false);
  });

  it('queues partial writes until drain', () => {
    let firstWrite = true;
    const protocol = createProtocol();
    const local = createIdentity();
    const remote = createIdentity();
    const socket = createSocket(data => {
      if (firstWrite) {
        firstWrite = false;
        return 5;
      }
      return data.length;
    });
    const manager = createManager(local.address, protocol);
    const sessionId = admit(manager, socket);
    const key = new Uint8Array(32).fill(9);
    manager.setSessionKeys(sessionId, key, key);
    manager.bindPeerIdentity(sessionId, remote.address);

    expect(manager.sendMessage(remote.address, protocol.encodeMessage('ping', { nonce: 1n }))).toBe(true);
    expect((manager.getConnection(remote.address) as any).queuedBytes).toBeGreaterThan(0);
    (manager as any).handleBackpressure(socket);
    expect((manager.getConnection(remote.address) as any).queuedBytes).toBe(0);
  });

  it('isolates socket write failures', () => {
    const protocol = createProtocol();
    const local = createIdentity();
    const remote = createIdentity();
    const socket = createSocket(() => { throw new Error('closed'); });
    const manager = createManager(local.address, protocol);
    const sessionId = admit(manager, socket);
    const key = new Uint8Array(32).fill(3);
    manager.setSessionKeys(sessionId, key, key);
    manager.bindPeerIdentity(sessionId, remote.address);

    expect(manager.sendMessage(remote.address, protocol.encodeMessage('ping', { nonce: 1n }))).toBe(false);
    expect(manager.isAuthenticated(remote.address)).toBe(false);
  });
});

describe('authenticated peer handshake', () => {
  it('authenticates peers and rejects replayed application frames', async () => {
    const identityA = createIdentity();
    const identityB = createIdentity();
    const protocolA = createProtocol();
    const protocolB = createProtocol();
    const managerA = createManager(identityA.address, protocolA);
    const managerB = createManager(identityB.address, protocolB);
    const discoveryA = Object.assign(new EventEmitter(), { getPeer: () => null });
    const discoveryB = Object.assign(new EventEmitter(), { getPeer: () => null });
    new SyncManager({
      blockchain: {
        getHeight: async () => 0,
        getBlock: async () => null,
        getLatestBlock: async () => null
      } as any,
      connectionManager: managerA,
      protocol: protocolA,
      discoveryService: discoveryA as any,
      chainConfig: mainnet,
      genesisHash,
      identity: identityA
    });
    new SyncManager({
      blockchain: {
        getHeight: async () => 0,
        getBlock: async () => null,
        getLatestBlock: async () => null
      } as any,
      connectionManager: managerB,
      protocol: protocolB,
      discoveryService: discoveryB as any,
      chainConfig: mainnet,
      genesisHash,
      identity: identityB
    });

    let socketA: any;
    let socketB: any;
    const sentByA: Uint8Array[] = [];
    socketA = createSocket(data => {
      const copy = data.slice();
      sentByA.push(copy);
      queueMicrotask(() => (managerB as any).handleData(socketB, copy));
      return data.length;
    });
    socketB = createSocket(data => {
      const copy = data.slice();
      queueMicrotask(() => (managerA as any).handleData(socketA, copy));
      return data.length;
    });

    admit(managerA, socketA, false, identityB.address);
    admit(managerB, socketB, true);
    for (let i = 0; i < 50 && !managerA.isAuthenticated(identityB.address); i++) await Bun.sleep(5);

    expect(managerA.isAuthenticated(identityB.address)).toBe(true);
    expect(managerB.isAuthenticated(identityA.address)).toBe(true);

    const received: string[] = [];
    managerB.on('message:received', (peerId, message) => {
      if (protocolB.decodeMessage(message)?.command === 'ping') received.push(peerId);
    });
    managerA.sendMessage(identityB.address, protocolA.encodeMessage('ping', { nonce: 99n }));
    await Bun.sleep(5);
    expect(received).toEqual([identityA.address]);

    const authenticatedFrame = sentByA.find(message =>
      new DataView(message.buffer, message.byteOffset).getBigUint64(16, false) === 1n
    );
    expect(authenticatedFrame).toBeDefined();
    (managerB as any).handleData(socketB, authenticatedFrame!);
    expect(managerB.isAuthenticated(identityA.address)).toBe(false);
  });

  it('rejects a verack replayed against another challenge', async () => {
    const local = createIdentity();
    const remote = createIdentity();
    const protocol = createProtocol();
    let disconnected = false;
    const connectionManager = Object.assign(new EventEmitter(), {
      getConnection: () => ({ inbound: false }),
      disconnect: () => { disconnected = true; },
      bindPeerIdentity: () => true
    });
    const sync = new SyncManager({
      blockchain: {} as any,
      connectionManager: connectionManager as any,
      protocol,
      discoveryService: Object.assign(new EventEmitter(), { getPeer: () => null }) as any,
      chainConfig: mainnet,
      genesisHash,
      identity: local
    });
    (sync as any).handshakes.set('session', {
      inbound: false,
      localNonce: 2n,
      remoteNonce: 1n,
      remoteNodeId: remote.address,
      remotePublicKey: remote.publicKey,
      versionReceived: true
    });
    const unsigned = {
      role: 'responder' as const,
      senderNodeId: remote.address,
      receiverNodeId: local.address,
      senderNonce: 1n,
      receiverNonce: 999n
    };
    const replay = {
      ...unsigned,
      signature: await sign(protocol.verackSigningPayload(unsigned), remote.privateKey)
    };

    connectionManager.emit('message:received', 'session', protocol.encodeMessage('verack', replay));
    await Bun.sleep(0);
    expect(disconnected).toBe(true);
  });

  it('disconnects peers whose async dispatch backlog exceeds its cap', () => {
    const identity = createIdentity();
    const protocol = createProtocol();
    let disconnected = false;
    const connectionManager = Object.assign(new EventEmitter(), {
      getConnection: () => ({}),
      disconnect: () => { disconnected = true; },
      sendMessage: () => true
    });
    const message = protocol.encodeMessage('ping', { nonce: 1n });
    new SyncManager({
      blockchain: {} as any,
      connectionManager: connectionManager as any,
      protocol,
      discoveryService: Object.assign(new EventEmitter(), { getPeer: () => null }) as any,
      chainConfig: mainnet,
      genesisHash,
      identity,
      maxQueuedMessageBytes: message.length
    });

    connectionManager.emit('message:received', 'peer', message);
    connectionManager.emit('message:received', 'peer', message);
    expect(disconnected).toBe(true);
  });

  it('retains aggregate queue accounting until closed sessions release', async () => {
    const identity = createIdentity();
    const protocol = createProtocol();
    const active = new Set(['old']);
    let disconnected = false;
    const connectionManager = Object.assign(new EventEmitter(), {
      getConnection: (sessionId: string) => active.has(sessionId) ? {} : undefined,
      disconnect: () => { disconnected = true; },
      sendMessage: () => true
    });
    const never = new Promise(() => {});
    const blocking = protocol.encodeMessage('getblocks', {
      locator: ['0'.repeat(64)],
      stopHash: '0'.repeat(64)
    });
    const sync = new SyncManager({
      blockchain: { getBlockByHash: () => never } as any,
      connectionManager: connectionManager as any,
      protocol,
      discoveryService: Object.assign(new EventEmitter(), { getPeer: () => null }) as any,
      chainConfig: mainnet,
      genesisHash,
      identity,
      maxQueuedMessageBytes: blocking.length * 2,
      maxTotalQueuedMessageBytes: blocking.length
    });

    connectionManager.emit('message:received', 'peer', blocking, 'old');
    await Bun.sleep(0);
    active.delete('old');
    connectionManager.emit('connection:closed', 'old', 'peer');
    active.add('new');
    connectionManager.emit('message:received', 'peer', blocking, 'new');
    expect(disconnected).toBe(true);
    void sync;
  });

  it('stops message intake and drains active queues', async () => {
    const identity = createIdentity();
    const protocol = createProtocol();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let lookups = 0;
    const connectionManager = Object.assign(new EventEmitter(), {
      getConnection: () => ({}),
      disconnect: () => {},
      sendMessage: () => true
    });
    const sync = new SyncManager({
      blockchain: {
        getBlockByHash: async () => {
          lookups++;
          await blocked;
          return null;
        },
        getBlock: async () => null,
        getHeight: async () => 0
      } as any,
      connectionManager: connectionManager as any,
      protocol,
      discoveryService: Object.assign(new EventEmitter(), { getPeer: () => null }) as any,
      chainConfig: mainnet,
      genesisHash,
      identity
    });
    const message = protocol.encodeMessage('getblocks', {
      locator: ['0'.repeat(64)],
      stopHash: '0'.repeat(64)
    });

    connectionManager.emit('message:received', 'peer', message, 'session');
    await Bun.sleep(0);
    const stopping = sync.stop();
    connectionManager.emit('message:received', 'peer', message, 'session');
    release();
    await stopping;

    expect(lookups).toBe(1);
    expect((sync as any).messageQueues.size).toBe(0);
    expect((sync as any).totalQueuedMessageBytes).toBe(0);
  });

  it('drains discovery-triggered storage work before stopping', async () => {
    const identity = createIdentity();
    const protocol = createProtocol();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let heightReads = 0;
    const connectionManager = Object.assign(new EventEmitter(), {
      isAuthenticated: () => true,
      getConnection: () => ({ id: 'session', authenticated: true }),
      disconnect: () => {},
      sendMessage: () => true
    });
    const discoveryService = Object.assign(new EventEmitter(), { getPeer: () => null });
    const sync = new SyncManager({
      blockchain: {
        getHeight: async () => {
          heightReads++;
          await blocked;
          return 0;
        },
        getBlock: async () => null
      } as any,
      connectionManager: connectionManager as any,
      protocol,
      discoveryService: discoveryService as any,
      chainConfig: mainnet,
      genesisHash,
      identity
    });
    discoveryService.emit('peer:discovered', {
      nodeId: createIdentity().address,
      height: 0
    });
    await Bun.sleep(0);
    let stopped = false;
    const stopping = sync.stop().then(() => { stopped = true; });
    await Bun.sleep(0);

    expect(heightReads).toBe(1);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('peer discovery authentication', () => {
  it('accepts signed chain announcements and rejects tampering', async () => {
    const identity = createIdentity();
    const service = new PeerDiscoveryService({
      identity: createIdentity(),
      chainId: mainnet.chainId,
      genesisHash,
      addressPrefix: mainnet.addressPrefix,
      tcpHost: 'localhost',
      tcpPort: 8333
    });
    const unsigned = {
      nodeId: identity.address,
      publicKey: identity.publicKey,
      tcp: '127.0.0.1:8333',
      height: 10,
      tipHash: 'cd'.repeat(32),
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      capabilities: ['full_node']
    };
    const announcement = {
      ...unsigned,
      signature: await sign((service as any).announcementPayload(unsigned), identity.privateKey)
    };

    expect(await (service as any).validatePeerEndpoint(announcement)).toBe(true);
    expect(await (service as any).validatePeerEndpoint({ ...announcement, tcp: '127.0.0.1:8334' })).toBe(false);
  });

  it('accepts bracketed IPv6 endpoints and rejects unsafe heights', async () => {
    const identity = createIdentity();
    const service = new PeerDiscoveryService({
      identity: createIdentity(),
      chainId: mainnet.chainId,
      genesisHash,
      addressPrefix: mainnet.addressPrefix,
      tcpHost: '::1',
      tcpPort: 8333
    });
    const unsigned = {
      nodeId: identity.address,
      publicKey: identity.publicKey,
      tcp: '[2606:4700:4700::1111]:8333',
      height: 10,
      tipHash: 'cd'.repeat(32),
      chainId: mainnet.chainId,
      genesisHash,
      version: '1.0.0',
      timestamp: Date.now(),
      capabilities: ['full_node']
    };
    const announcement = {
      ...unsigned,
      signature: await sign((service as any).announcementPayload(unsigned), identity.privateKey)
    };

    expect(parsePeerEndpoint(announcement.tcp)).toEqual({ host: '2606:4700:4700::1111', port: 8333 });
    expect(await (service as any).validatePeerEndpoint(announcement)).toBe(true);
    expect(await (service as any).validatePeerEndpoint({ ...announcement, height: Infinity })).toBe(false);
  });

  it('emits fresh announcements and ignores validation completed after stop', async () => {
    const identity = createIdentity();
    const service = new PeerDiscoveryService({
      identity: createIdentity(),
      chainId: mainnet.chainId,
      genesisHash,
      addressPrefix: mainnet.addressPrefix,
      tcpHost: 'localhost',
      tcpPort: 8333
    });
    let handler!: (message: any) => Promise<void>;
    const client = {
      pubsub: {
        subscribe: async (_topic: string, callback: typeof handler) => { handler = callback; },
        unsubscribe: async () => {}
      }
    };
    (service as any).ipfs = client;
    (service as any).isRunning = true;
    (service as any).runGeneration = 1;
    await (service as any).subscribeToPeers(client, 1);
    let discovered = 0;
    let updated = 0;
    service.on('peer:discovered', () => { discovered++; });
    service.on('peer:updated', () => { updated++; });
    const createAnnouncement = async (timestamp: number) => {
      const unsigned = {
        nodeId: identity.address,
        publicKey: identity.publicKey,
        tcp: '1.1.1.1:8333',
        height: 0,
        tipHash: genesisHash,
        chainId: mainnet.chainId,
        genesisHash,
        version: '1.0.0',
        timestamp,
        capabilities: ['full_node']
      };
      return {
        ...unsigned,
        signature: await sign((service as any).announcementPayload(unsigned), identity.privateKey)
      };
    };
    const now = Date.now();
    const publish = async (timestamp: number) => handler({
      type: 'signed',
      from: { toString: () => 'peer-id' },
      data: new TextEncoder().encode(JSON.stringify(await createAnnouncement(timestamp)))
    });

    await publish(now);
    await publish(now + 1);
    expect(discovered).toBe(1);
    expect(updated).toBe(1);

    await service.stop();
    await publish(now + 2);
    expect(service.getKnownPeers()).toHaveLength(0);
    expect(discovered).toBe(1);
    expect(updated).toBe(1);
  });

  it('evicts old sender quotas instead of blocking unseen senders', () => {
    const service = new PeerDiscoveryService({
      identity: createIdentity(),
      chainId: mainnet.chainId,
      genesisHash,
      addressPrefix: mainnet.addressPrefix,
      tcpHost: 'localhost',
      tcpPort: 8333,
      maxKnownPeers: 2,
      maxAnnouncementsPerMinute: 1,
      maxTotalAnnouncementsPerMinute: 100
    });

    expect((service as any).acceptAnnouncement('one')).toBe(true);
    expect((service as any).acceptAnnouncement('two')).toBe(true);
    expect((service as any).acceptAnnouncement('three')).toBe(true);
    expect((service as any).acceptAnnouncement('four')).toBe(true);
    expect((service as any).acceptAnnouncement('honest')).toBe(true);
  });

  it('does not charge sender rejections to global quota', () => {
    const service = new PeerDiscoveryService({
      identity: createIdentity(),
      chainId: mainnet.chainId,
      genesisHash,
      addressPrefix: mainnet.addressPrefix,
      tcpHost: 'localhost',
      tcpPort: 8333,
      maxAnnouncementsPerMinute: 1,
      maxTotalAnnouncementsPerMinute: 2
    });

    expect((service as any).acceptAnnouncement('attacker')).toBe(true);
    expect((service as any).acceptAnnouncement('attacker')).toBe(false);
    expect((service as any).acceptAnnouncement('attacker')).toBe(false);
    expect((service as any).acceptAnnouncement('honest')).toBe(true);
  });
});

describe('transaction relay lifecycle', () => {
  it('removes external listeners when stopped and reattaches once', () => {
    const mempool = Object.assign(new EventEmitter(), { getTransaction: () => null });
    const connectionManager = Object.assign(new EventEmitter(), { getConnectedPeers: () => [] });
    const relay = new TransactionRelay({
      mempool: mempool as any,
      connectionManager: connectionManager as any,
      inventoryManager: { broadcastInventory: () => {} } as any,
      protocol: createProtocol()
    });

    relay.start();
    expect(mempool.listenerCount('transactionAdded')).toBe(1);
    expect(connectionManager.listenerCount('message:received')).toBe(0);
    relay.stop();
    expect(mempool.listenerCount('transactionAdded')).toBe(0);
    expect(connectionManager.listenerCount('message:received')).toBe(0);
    relay.start();
    expect(mempool.listenerCount('transactionAdded')).toBe(1);
    relay.stop();
  });

  it('admits remote transactions once and excludes their source from relay', async () => {
    const mempool = Object.assign(new EventEmitter(), {
      hasTransaction: () => false,
      addTransaction: async function (tx: any) { this.emit('transactionAdded', tx); },
      getTransaction: () => null
    });
    const connectionManager = Object.assign(new EventEmitter(), { getConnectedPeers: () => [] });
    let excluded: Map<string, string> | undefined;
    const inventoryManager = {
      broadcastInventory: (_items: any[], peers: Map<string, string>) => { excluded = peers; },
      wasAnnouncedToPeer: () => true
    };
    const relay = new TransactionRelay({
      mempool: mempool as any,
      connectionManager: connectionManager as any,
      inventoryManager: inventoryManager as any,
      protocol: createProtocol()
    });
    const hash = 'ab'.repeat(32);
    relay.start();

    expect(await relay.handleTransaction('source', {
      chainId: mainnet.chainId,
      kind: 'transfer',
      hash,
      from: createIdentity().address,
      to: createIdentity().address,
      amount: '1',
      fee: '1',
      nonce: 0,
      timestamp: Date.now()
    })).toBe(true);
    (relay as any).processRelayQueue();

    expect(excluded?.get(hash)).toBe('source');
    expect(relay.getStats().recentTxCount).toBe(1);
    relay.stop();
  });
});
