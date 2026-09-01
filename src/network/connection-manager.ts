import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Socket } from 'bun';
import { parsePeerEndpoint, type PeerEndpoint } from './peer-discovery';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  MessageType,
  PROTOCOL_AUTH_TAG_OFFSET,
  PROTOCOL_AUTH_TAG_SIZE,
  PROTOCOL_HEADER_SIZE,
  type Protocol
} from './protocol';

const logger = getLogger(__filename);
const MAX_HANDSHAKE_PAYLOAD = 4096;
type DialAttempt = { expired: boolean };

export interface PeerConnection {
  id: string;
  peerId?: string;
  expectedPeerId?: string;
  dialEndpoint?: string;
  socket: Socket;
  endpoint: string;
  inbound: boolean;
  connected: boolean;
  authenticated: boolean;
  connectedAt: number;
  lastSeen: number;
  version?: string;
  height?: number;
  chainHash?: string;
  messageBuffer: Uint8Array;
  messageBufferLength: number;
  sendQueue: Uint8Array[];
  sendOffset: number;
  queuedBytes: number;
  sendKey?: Uint8Array;
  receiveKey?: Uint8Array;
  sendSequence: bigint;
  receiveSequence: bigint;
  lastPingAt?: number;
}

export interface ConnectionManagerConfig {
  nodeId: string;
  tcpPort: number;
  protocol: Protocol;
  maxConnections?: number;
  maxPendingConnections?: number;
  maxInboundConnections?: number;
  maxUnauthenticatedPerAddress?: number;
  maxInboundAttemptsPerMinute?: number;
  maxMessageSize?: number;
  maxBufferedBytes?: number;
  maxSendBuffer?: number;
  initialBufferSize?: number;
  allowPrivatePeers?: boolean;
  connectionTimeout?: number;
  messageTimeout?: number;
  endpointRetryDelay?: number;
  maxEndpointAttemptsPerMinute?: number;
  dnsTimeout?: number;
}

/**
 * manages authenticated tcp connections using bun's native tcp
 */
export class ConnectionManager extends EventEmitter {
  private config: Required<ConnectionManagerConfig>;
  private server: any = null;
  private connections = new Map<string, PeerConnection>();
  private peerToSession = new Map<string, string>();
  private socketToId = new Map<Socket, string>();
  private pendingPeers = new Map<string, DialAttempt>();
  private pendingEndpoints = new Map<string, DialAttempt>();
  private nativeAttempts = new Set<DialAttempt>();
  private failedEndpoints = new Map<string, number>();
  private failedPeerEndpoints = new Map<string, number>();
  private endpointAttempts = new Map<string, { startedAt: number; count: number }>();
  private endpointRetries = new Map<string, { peer: PeerEndpoint; timer: ReturnType<typeof setTimeout> }>();
  private inboundAttempts = new Map<string, { startedAt: number; count: number }>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private runGeneration = 0;

  constructor(config: ConnectionManagerConfig) {
    super();
    const maxConnections = config.maxConnections ?? 125;
    const maxMessageSize = config.maxMessageSize ?? 10 * 1024 * 1024;
    this.config = {
      maxConnections,
      maxPendingConnections: config.maxPendingConnections ?? 8,
      maxInboundConnections: config.maxInboundConnections ?? Math.floor(maxConnections * 0.8),
      maxUnauthenticatedPerAddress: config.maxUnauthenticatedPerAddress ?? 4,
      maxInboundAttemptsPerMinute: config.maxInboundAttemptsPerMinute ?? 8,
      maxMessageSize,
      maxBufferedBytes: config.maxBufferedBytes ?? maxMessageSize + PROTOCOL_HEADER_SIZE,
      maxSendBuffer: config.maxSendBuffer ?? 2 * (maxMessageSize + PROTOCOL_HEADER_SIZE),
      initialBufferSize: config.initialBufferSize ?? 4096,
      allowPrivatePeers: config.allowPrivatePeers ?? false,
      connectionTimeout: config.connectionTimeout ?? 30000,
      messageTimeout: config.messageTimeout ?? 60000,
      endpointRetryDelay: config.endpointRetryDelay ?? 60000,
      maxEndpointAttemptsPerMinute: config.maxEndpointAttemptsPerMinute ?? 3,
      dnsTimeout: config.dnsTimeout ?? 5000,
      ...config
    };
    if (this.config.maxBufferedBytes < PROTOCOL_HEADER_SIZE + this.config.maxMessageSize) {
      throw new Error('receive buffer must hold one maximum-size frame');
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('connection manager already running');
      return;
    }

    this.isRunning = true;
    this.runGeneration++;
    try {
      this.server = Bun.listen({
      hostname: '0.0.0.0',
      port: this.config.tcpPort,
      socket: {
        data: (socket, data) => this.handleData(socket, data),
        open: socket => { this.handleNewConnection(socket, true); },
        close: socket => this.handleDisconnection(socket),
        drain: socket => this.handleBackpressure(socket),
        error: (socket, error) => this.handleError(socket, error)
      }
      });
    } catch (error) {
      this.isRunning = false;
      this.runGeneration++;
      throw error;
    }

    this.startHealthCheck();
    logger.info(`tcp server listening on port ${this.config.tcpPort}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.runGeneration++;

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const connection of [...this.connections.values()]) {
      this.closeSocket(connection.socket);
      this.handleDisconnection(connection.socket);
    }
    this.server?.stop(true);
    this.server = null;
    this.pendingPeers.clear();
    this.pendingEndpoints.clear();
    this.failedEndpoints.clear();
    this.failedPeerEndpoints.clear();
    this.endpointAttempts.clear();
    this.inboundAttempts.clear();
    for (const retry of this.endpointRetries.values()) clearTimeout(retry.timer);
    this.endpointRetries.clear();
    logger.info('connection manager stopped');
  }

  async connectToPeer(endpoint: PeerEndpoint): Promise<boolean> {
    if (!this.isRunning) return false;
    if (endpoint.nodeId === this.config.nodeId) return false;
    if (this.peerToSession.has(endpoint.nodeId) || this.pendingPeers.has(endpoint.nodeId)) return true;
    if (this.nativeAttempts.size >= this.config.maxPendingConnections ||
        this.connections.size + this.nativeAttempts.size >= this.config.maxConnections) return false;

    const parsedEndpoint = parsePeerEndpoint(endpoint.tcp);
    if (!parsedEndpoint) return false;
    const { host, port } = parsedEndpoint;

    const attempt: DialAttempt = { expired: false };
    this.nativeAttempts.add(attempt);
    this.pendingPeers.set(endpoint.nodeId, attempt);
    const generation = this.runGeneration;
    let dialEndpoint: string | undefined;
    let admitted = false;
    let dialPromise: Promise<Socket> | undefined;
    try {
      const addresses = await this.resolveHost(host);
      if (!this.isRunning || generation !== this.runGeneration) return false;
      if (addresses.length === 0 ||
          (!this.config.allowPrivatePeers && addresses.some(({ address }) => this.isPrivateAddress(address)))) {
        logger.warn(`refusing peer endpoint outside egress policy: ${endpoint.tcp}`);
        return false;
      }
      dialEndpoint = `${addresses[0].address}:${port}`;
      const failedAt = this.failedEndpoints.get(dialEndpoint);
      if (failedAt && Date.now() - failedAt < this.config.endpointRetryDelay) return false;
      if (failedAt) this.failedEndpoints.delete(dialEndpoint);
      const peerEndpoint = `${endpoint.nodeId}@${dialEndpoint}`;
      const peerFailedAt = this.failedPeerEndpoints.get(peerEndpoint);
      if (peerFailedAt && Date.now() - peerFailedAt < this.config.endpointRetryDelay) return false;
      if (peerFailedAt) this.failedPeerEndpoints.delete(peerEndpoint);
      if (this.pendingEndpoints.has(dialEndpoint) ||
          [...this.connections.values()].some(connection => connection.dialEndpoint === dialEndpoint)) {
        return false;
      }
      if (!this.allowEndpointAttempt(dialEndpoint)) {
        this.scheduleEndpointRetry(dialEndpoint, endpoint);
        return false;
      }
      this.pendingEndpoints.set(dialEndpoint, attempt);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        dialPromise = Bun.connect({
          hostname: addresses[0].address,
          port,
          socket: {
            data: (socket, data) => this.handleData(socket, data),
            open: socket => {
              admitted = this.handleNewConnection(
                socket,
                false,
                endpoint.nodeId,
                dialEndpoint,
                generation,
                attempt
              );
            },
            close: socket => this.handleDisconnection(socket),
            drain: socket => this.handleBackpressure(socket),
            error: (socket, error) => this.handleError(socket, error),
            timeout: socket => this.handleTimeout(socket)
          }
        });
        void dialPromise.then(
          () => {
            this.nativeAttempts.delete(attempt);
            this.clearPendingAttempt(endpoint.nodeId, dialEndpoint, attempt);
          },
          () => {
            this.nativeAttempts.delete(attempt);
            this.clearPendingAttempt(endpoint.nodeId, dialEndpoint, attempt);
          }
        );
        await Promise.race([
          dialPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              attempt.expired = true;
              reject(new Error('tcp dial timed out'));
            }, this.config.connectionTimeout);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return admitted;
    } catch (error) {
      if (dialEndpoint) this.markEndpointFailed(dialEndpoint);
      logger.error(`failed to connect to ${endpoint.nodeId}:`, error);
      return false;
    } finally {
      if (!dialPromise) {
        this.nativeAttempts.delete(attempt);
        this.clearPendingAttempt(endpoint.nodeId, dialEndpoint, attempt);
      }
    }
  }

  private handleNewConnection(
    socket: Socket,
    inbound: boolean,
    expectedPeerId?: string,
    dialEndpoint?: string,
    generation = this.runGeneration,
    attempt?: DialAttempt
  ): boolean {
    const inboundCount = [...this.connections.values()].filter(connection => connection.inbound).length;
    if (!this.isRunning || generation !== this.runGeneration || this.connections.size >= this.config.maxConnections ||
        (attempt && (attempt.expired || !expectedPeerId || !dialEndpoint ||
          this.pendingPeers.get(expectedPeerId) !== attempt || this.pendingEndpoints.get(dialEndpoint) !== attempt)) ||
        (inbound && (inboundCount >= this.config.maxInboundConnections ||
          !this.allowInboundAttempt(socket.remoteAddress || 'unknown')))) {
      this.closeSocket(socket);
      return false;
    }

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const connection: PeerConnection = {
      id: sessionId,
      expectedPeerId,
      dialEndpoint,
      socket,
      endpoint: socket.remoteAddress || 'unknown',
      inbound,
      connected: true,
      authenticated: false,
      connectedAt: now,
      lastSeen: now,
      messageBuffer: new Uint8Array(Math.min(this.config.initialBufferSize, this.config.maxBufferedBytes)),
      messageBufferLength: 0,
      sendQueue: [],
      sendOffset: 0,
      queuedBytes: 0,
      sendSequence: 1n,
      receiveSequence: 1n
    };

    this.connections.set(sessionId, connection);
    this.socketToId.set(socket, sessionId);
    logger.info(`${inbound ? 'accepted' : 'established'} connection ${sessionId} from ${connection.endpoint}`);
    this.emit('peer:connected', sessionId, inbound);
    return true;
  }

  private handleData(socket: Socket, data: Uint8Array): void {
    const sessionId = this.socketToId.get(socket);
    const connection = sessionId ? this.connections.get(sessionId) : undefined;
    if (!connection) return;
    connection.lastSeen = Date.now();

    let offset = 0;
    while (offset < data.length && this.connections.has(connection.id)) {
      if (connection.messageBufferLength === this.config.maxBufferedBytes) {
        const previousLength = connection.messageBufferLength;
        this.processMessageBuffer(connection);
        if (connection.messageBufferLength === previousLength) {
          this.protocolViolation(connection, 'receive buffer limit exceeded');
          return;
        }
      }

      const writeLength = Math.min(
        data.length - offset,
        this.config.maxBufferedBytes - connection.messageBufferLength
      );
      this.ensureBufferCapacity(connection, connection.messageBufferLength + writeLength);
      connection.messageBuffer.set(data.subarray(offset, offset + writeLength), connection.messageBufferLength);
      connection.messageBufferLength += writeLength;
      offset += writeLength;
      this.processMessageBuffer(connection);
    }
  }

  private ensureBufferCapacity(connection: PeerConnection, required: number): void {
    if (required <= connection.messageBuffer.length) return;
    const capacity = Math.min(
      this.config.maxBufferedBytes,
      Math.max(required, connection.messageBuffer.length * 2)
    );
    const buffer = new Uint8Array(capacity);
    buffer.set(connection.messageBuffer.subarray(0, connection.messageBufferLength));
    connection.messageBuffer = buffer;
  }

  private processMessageBuffer(connection: PeerConnection): void {
    let offset = 0;
    const buffer = connection.messageBuffer;

    while (connection.messageBufferLength - offset >= PROTOCOL_HEADER_SIZE) {
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset, PROTOCOL_HEADER_SIZE);
      const magic = view.getUint32(0, false);
      const type = view.getUint32(4, false) as MessageType;
      const payloadLength = view.getUint32(8, false);

      if (magic !== this.config.protocol.networkMagic) {
        this.protocolViolation(connection, 'invalid network magic');
        return;
      }
      if (payloadLength > this.config.maxMessageSize) {
        this.protocolViolation(connection, 'message payload limit exceeded');
        return;
      }
      if (!connection.authenticated &&
          (type !== MessageType.VERSION && type !== MessageType.VERACK || payloadLength > MAX_HANDSHAKE_PAYLOAD)) {
        this.protocolViolation(connection, 'application message before authentication');
        return;
      }
      if (connection.authenticated && (type === MessageType.VERSION || type === MessageType.VERACK)) {
        this.protocolViolation(connection, 'duplicate handshake message');
        return;
      }

      const messageLength = PROTOCOL_HEADER_SIZE + payloadLength;
      if (connection.messageBufferLength - offset < messageLength) break;
      const message = buffer.slice(offset, offset + messageLength);

      if (connection.authenticated) {
        if (!connection.receiveKey || !this.config.protocol.verifyAuthenticatedMessage(
          message,
          connection.receiveKey,
          connection.receiveSequence
        )) {
          this.protocolViolation(connection, 'invalid message authentication');
          return;
        }
        connection.receiveSequence++;
      } else if (!this.hasEmptyAuthentication(message)) {
        this.protocolViolation(connection, 'unexpected pre-authentication tag');
        return;
      }

      this.emit(
        'message:received',
        connection.authenticated ? connection.peerId! : connection.id,
        message,
        connection.id
      );
      offset += messageLength;
      if (!this.connections.has(connection.id)) return;
      if (!connection.authenticated) break;
    }

    if (offset > 0 && this.connections.has(connection.id)) {
      connection.messageBuffer.copyWithin(0, offset, connection.messageBufferLength);
      connection.messageBufferLength -= offset;
      if (connection.messageBufferLength === 0 && connection.messageBuffer.length > this.config.initialBufferSize) {
        connection.messageBuffer = new Uint8Array(this.config.initialBufferSize);
      }
    }
  }

  private hasEmptyAuthentication(message: Uint8Array): boolean {
    const view = new DataView(message.buffer, message.byteOffset, PROTOCOL_HEADER_SIZE);
    if (view.getBigUint64(16, false) !== 0n) return false;
    for (let i = PROTOCOL_AUTH_TAG_OFFSET; i < PROTOCOL_AUTH_TAG_OFFSET + PROTOCOL_AUTH_TAG_SIZE; i++) {
      if (message[i] !== 0) return false;
    }
    return true;
  }

  sendMessage(targetId: string, data: Uint8Array): boolean {
    const connection = this.resolveConnection(targetId);
    if (!connection?.connected || data.length < PROTOCOL_HEADER_SIZE) return false;

    const view = new DataView(data.buffer, data.byteOffset, PROTOCOL_HEADER_SIZE);
    const type = view.getUint32(4, false) as MessageType;
    const handshake = type === MessageType.VERSION || type === MessageType.VERACK;
    if (!connection.authenticated && !handshake) return false;
    if (connection.authenticated && handshake) return false;

    const message = connection.authenticated
      ? this.config.protocol.authenticateMessage(data, connection.sendKey!, connection.sendSequence++)
      : data;
    if (connection.queuedBytes + message.length > this.config.maxSendBuffer) {
      this.protocolViolation(connection, 'send buffer limit exceeded');
      return false;
    }

    connection.sendQueue.push(message);
    connection.queuedBytes += message.length;
    this.flushSendQueue(connection);
    return connection.connected;
  }

  private flushSendQueue(connection: PeerConnection): void {
    try {
      while (connection.sendQueue.length > 0 && connection.connected) {
        const message = connection.sendQueue[0];
        const remaining = message.subarray(connection.sendOffset);
        const written = connection.socket.write(remaining);
        if (written <= 0) return;
        connection.sendOffset += written;
        connection.queuedBytes -= written;
        if (connection.sendOffset < message.length) return;
        connection.sendQueue.shift();
        connection.sendOffset = 0;
      }
    } catch (error) {
      logger.warn(`write failed for ${connection.peerId || connection.id}`, error);
      this.protocolViolation(connection, 'socket write failed');
    }
  }

  setSessionKeys(sessionId: string, sendKey: Uint8Array, receiveKey: Uint8Array): boolean {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.authenticated) return false;
    connection.sendKey = sendKey.slice();
    connection.receiveKey = receiveKey.slice();
    return true;
  }

  bindPeerIdentity(sessionId: string, peerId: string): boolean {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.authenticated || !connection.sendKey || !connection.receiveKey) return false;
    if (peerId === this.config.nodeId) return false;

    const existingId = this.peerToSession.get(peerId);
    if (existingId && existingId !== sessionId) {
      const existing = this.connections.get(existingId);
      const preferInbound = this.config.nodeId > peerId;
      const currentPreferred = connection.inbound === preferInbound;
      const existingPreferred = existing?.inbound === preferInbound;
      if (!currentPreferred || currentPreferred === existingPreferred) return false;
      if (existing) this.disconnect(existing.id, 'duplicate peer connection');
    }

    connection.peerId = peerId;
    connection.authenticated = true;
    if (connection.dialEndpoint) this.failedEndpoints.delete(connection.dialEndpoint);
    if (connection.dialEndpoint && connection.expectedPeerId) {
      this.failedPeerEndpoints.delete(`${connection.expectedPeerId}@${connection.dialEndpoint}`);
    }
    this.peerToSession.set(peerId, sessionId);
    this.emit('peer:authenticated', peerId, sessionId);
    this.processMessageBuffer(connection);
    return true;
  }

  resumeHandshake(sessionId: string): void {
    const connection = this.connections.get(sessionId);
    if (connection && !connection.authenticated) this.processMessageBuffer(connection);
  }

  updatePeerInfo(targetId: string, info: { version?: string; height?: number; chainHash?: string }): void {
    const connection = this.resolveConnection(targetId);
    if (!connection) return;
    if (info.version) connection.version = info.version;
    if (info.height !== undefined) connection.height = info.height;
    if (info.chainHash) connection.chainHash = info.chainHash;
  }

  disconnect(targetId: string, reason = 'requested'): void {
    const connection = this.resolveConnection(targetId);
    if (!connection) return;
    logger.info(`disconnecting ${connection.peerId || connection.id}: ${reason}`);
    this.closeSocket(connection.socket);
    this.handleDisconnection(connection.socket);
  }

  private protocolViolation(connection: PeerConnection, reason: string): void {
    logger.warn(`disconnecting ${connection.peerId || connection.id}: ${reason}`);
    this.closeSocket(connection.socket);
    this.handleDisconnection(connection.socket);
  }

  private closeSocket(socket: Socket): void {
    try {
      if (typeof (socket as any).terminate === 'function') (socket as any).terminate();
      else socket.end();
    } catch (error) {
      logger.debug('error closing connection:', error);
    }
  }

  private handleDisconnection(socket: Socket): void {
    const sessionId = this.socketToId.get(socket);
    if (!sessionId) return;
    const connection = this.connections.get(sessionId);
    if (connection) {
      if (connection.dialEndpoint && !connection.authenticated) {
        if (connection.expectedPeerId) {
          this.markPeerEndpointFailed(`${connection.expectedPeerId}@${connection.dialEndpoint}`);
        }
      }
      connection.connected = false;
      if (connection.peerId && this.peerToSession.get(connection.peerId) === sessionId) {
        this.peerToSession.delete(connection.peerId);
      }
      this.connections.delete(sessionId);
      this.emit('connection:closed', sessionId, connection.peerId);
      this.emit('peer:disconnected', connection.peerId || sessionId);
    }
    this.socketToId.delete(socket);
  }

  private handleError(socket: Socket, error: Error): void {
    logger.error(`socket error for ${this.socketToId.get(socket)}:`, error);
    this.handleDisconnection(socket);
  }

  private handleTimeout(socket: Socket): void {
    const sessionId = this.socketToId.get(socket);
    if (sessionId) this.disconnect(sessionId, 'socket timeout');
  }

  private handleBackpressure(socket: Socket): void {
    const sessionId = this.socketToId.get(socket);
    const connection = sessionId ? this.connections.get(sessionId) : undefined;
    if (connection) this.flushSendQueue(connection);
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => this.checkConnectionHealth(), Math.min(30000, this.config.connectionTimeout));
  }

  private checkConnectionHealth(now = Date.now()): void {
    for (const connection of [...this.connections.values()]) {
      const timeout = connection.authenticated ? this.config.messageTimeout : this.config.connectionTimeout;
      const since = connection.authenticated ? connection.lastSeen : connection.connectedAt;
      if (now - since > timeout) {
        this.disconnect(connection.id, 'timeout');
      } else if (connection.authenticated && now - connection.lastSeen > timeout / 2 &&
          (!connection.lastPingAt || connection.lastPingAt <= connection.lastSeen)) {
        const nonce = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0);
        if (this.sendMessage(connection.id, this.config.protocol.encodeMessage('ping', { nonce }))) {
          connection.lastPingAt = now;
        }
      }
    }
  }

  private resolveConnection(targetId: string): PeerConnection | undefined {
    return this.connections.get(targetId) || this.connections.get(this.peerToSession.get(targetId) || '');
  }

  private markEndpointFailed(endpoint: string): void {
    this.failedEndpoints.delete(endpoint);
    this.failedEndpoints.set(endpoint, Date.now());
    const maxEntries = this.config.maxConnections * 8;
    if (this.failedEndpoints.size > maxEntries) {
      const oldest = this.failedEndpoints.keys().next().value;
      if (oldest) this.failedEndpoints.delete(oldest);
    }
  }

  private clearPendingAttempt(peerId: string, endpoint: string | undefined, attempt: DialAttempt): void {
    if (this.pendingPeers.get(peerId) === attempt) this.pendingPeers.delete(peerId);
    if (endpoint && this.pendingEndpoints.get(endpoint) === attempt) this.pendingEndpoints.delete(endpoint);
  }

  private markPeerEndpointFailed(peerEndpoint: string): void {
    this.failedPeerEndpoints.delete(peerEndpoint);
    this.failedPeerEndpoints.set(peerEndpoint, Date.now());
    const maxEntries = this.config.maxConnections * 8;
    if (this.failedPeerEndpoints.size > maxEntries) {
      const oldest = this.failedPeerEndpoints.keys().next().value;
      if (oldest) this.failedPeerEndpoints.delete(oldest);
    }
  }

  private allowEndpointAttempt(endpoint: string): boolean {
    const now = Date.now();
    let window = this.endpointAttempts.get(endpoint);
    if (!window || now - window.startedAt >= 60000) {
      window = { startedAt: now, count: 0 };
    }
    window.count++;
    this.endpointAttempts.delete(endpoint);
    this.endpointAttempts.set(endpoint, window);
    const maxEntries = this.config.maxConnections * 8;
    if (this.endpointAttempts.size > maxEntries) {
      const oldest = this.endpointAttempts.keys().next().value;
      if (oldest) this.endpointAttempts.delete(oldest);
    }
    return window.count <= this.config.maxEndpointAttemptsPerMinute;
  }

  private allowInboundAttempt(address: string): boolean {
    const now = Date.now();
    let window = this.inboundAttempts.get(address);
    if (!window || now - window.startedAt >= 60000) window = { startedAt: now, count: 0 };
    window.count++;
    this.inboundAttempts.delete(address);
    this.inboundAttempts.set(address, window);
    const maxEntries = this.config.maxConnections * 8;
    if (this.inboundAttempts.size > maxEntries) {
      const oldest = this.inboundAttempts.keys().next().value;
      if (oldest) this.inboundAttempts.delete(oldest);
    }
    if (window.count > this.config.maxInboundAttemptsPerMinute) return false;
    const unauthenticated = [...this.connections.values()].filter(connection =>
      connection.inbound && !connection.authenticated && connection.endpoint === address
    ).length;
    return unauthenticated < this.config.maxUnauthenticatedPerAddress;
  }

  private scheduleEndpointRetry(endpoint: string, peer: PeerEndpoint): void {
    const existing = this.endpointRetries.get(endpoint);
    if (existing) {
      existing.peer = peer;
      return;
    }
    const maxEntries = this.config.maxConnections * 8;
    if (this.endpointRetries.size >= maxEntries) return;
    const window = this.endpointAttempts.get(endpoint);
    const delay = Math.max(1, (window?.startedAt || Date.now()) + 60000 - Date.now());
    const retry = {
      peer,
      timer: setTimeout(() => {
        this.endpointRetries.delete(endpoint);
        if (this.isRunning) void this.connectToPeer(retry.peer);
      }, delay)
    };
    this.endpointRetries.set(endpoint, retry);
  }

  private isPrivateAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return true;
    if (family === 6) {
      const words = this.parseIPv6(address);
      if (!words) return true;
      if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
        return this.isPrivateAddress(`${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`);
      }
      if ((words[0] & 0xe000) !== 0x2000) return true;
      return words[0] === 0x2001 && words[1] === 0x0db8;
    }
    const parts = address.split('.').map(Number);
    const [first, second, third] = parts;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113);
  }

  private parseIPv6(address: string): number[] | null {
    const normalized = address.split('%')[0].toLowerCase();
    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const parse = (part: string): number[] | null => {
      if (!part) return [];
      const words: number[] = [];
      for (const token of part.split(':')) {
        if (token.includes('.')) {
          const bytes = token.split('.').map(Number);
          if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
          words.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
        } else {
          if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
          words.push(parseInt(token, 16));
        }
      }
      return words;
    };
    const left = parse(halves[0]);
    const right = parse(halves[1] || '');
    if (!left || !right) return null;
    if (halves.length === 1) return left.length === 8 ? left : null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    return [...left, ...new Array(missing).fill(0), ...right];
  }

  private async resolveHost(host: string): Promise<Array<{ address: string }>> {
    if (isIP(host)) return [{ address: host }];
    const resolver = new Resolver();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        resolver.cancel();
        reject(new Error('dns lookup timed out'));
      }, this.config.dnsTimeout);
    });
    try {
      return await Promise.race([
        Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]).then(results =>
          results.flatMap(result => result.status === 'fulfilled'
            ? result.value.map(address => ({ address }))
            : [])
        ),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getConnectedPeers(): string[] {
    return [...this.peerToSession.keys()].filter(peerId => this.isAuthenticated(peerId));
  }

  getConnection(targetId: string): PeerConnection | undefined {
    return this.resolveConnection(targetId);
  }

  isConnected(peerId: string): boolean {
    return this.isAuthenticated(peerId);
  }

  isAuthenticated(peerId: string): boolean {
    const connection = this.resolveConnection(peerId);
    return connection?.connected === true && connection.authenticated;
  }

  getStats(): {
    totalConnections: number;
    authenticatedConnections: number;
    inboundConnections: number;
    outboundConnections: number;
    authenticatedInboundConnections: number;
    authenticatedOutboundConnections: number;
    maxConnections: number;
  } {
    let inbound = 0;
    let outbound = 0;
    let authenticatedInbound = 0;
    let authenticatedOutbound = 0;
    for (const connection of this.connections.values()) {
      if (connection.inbound) {
        inbound++;
        if (connection.authenticated) authenticatedInbound++;
      } else {
        outbound++;
        if (connection.authenticated) authenticatedOutbound++;
      }
    }
    return {
      totalConnections: this.connections.size,
      authenticatedConnections: this.peerToSession.size,
      inboundConnections: inbound,
      outboundConnections: outbound,
      authenticatedInboundConnections: authenticatedInbound,
      authenticatedOutboundConnections: authenticatedOutbound,
      maxConnections: this.config.maxConnections
    };
  }
}
