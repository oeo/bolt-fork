import { getLogger } from '../utils/logger';
import { Protocol, MessageType, PROTOCOL_VERSION, type VersionMessage } from './protocol';
import type { Server, Socket } from 'bun';

const logger = getLogger(__filename);

// connection states
enum ConnectionState {
  CONNECTING = 'connecting',
  HANDSHAKING = 'handshaking',
  CONNECTED = 'connected',
  DISCONNECTING = 'disconnecting',
  DISCONNECTED = 'disconnected',
}

// peer connection info
export interface PeerInfo {
  id: string;
  address: string;
  port: number;
  state: ConnectionState;
  version?: number;
  userAgent?: string;
  startHeight?: number;
  lastSeen: number;
  bytesReceived: number;
  bytesSent: number;
}

// server configuration
export interface ServerConfig {
  host?: string;
  port: number;
  maxPeers?: number;
  connectionTimeout?: number;
  pingInterval?: number;
  maxMessageSize?: number;
}

/**
 * tcp server for bolt network
 * handles peer connections and message routing
 */
export class TCPServer {
  private server?: Server;
  private protocol: Protocol;
  private peers: Map<string, PeerConnection> = new Map();
  private config: Required<ServerConfig>;
  private isRunning = false;
  private pingTimer?: Timer;

  constructor(config: ServerConfig) {
    this.protocol = new Protocol();
    this.config = {
      host: config.host || '0.0.0.0',
      port: config.port,
      maxPeers: config.maxPeers || 100,
      connectionTimeout: config.connectionTimeout || 60000,
      pingInterval: config.pingInterval || 30000,
      maxMessageSize: config.maxMessageSize || 4 * 1024 * 1024, // 4mb
    };
  }

  /**
   * start the tcp server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('server already running');
    }

    logger.info(`starting tcp server on ${this.config.host}:${this.config.port}`);

    this.server = Bun.listen({
      hostname: this.config.host,
      port: this.config.port,
      socket: {
        open: (socket) => this.handleConnection(socket),
        close: (socket) => this.handleDisconnection(socket),
        data: (socket, data) => this.handleData(socket, data),
        error: (socket, error) => this.handleError(socket, error),
        drain: (socket) => this.handleDrain(socket),
      },
    });

    this.isRunning = true;

    // start ping timer
    this.pingTimer = setInterval(() => this.pingAllPeers(), this.config.pingInterval);

    logger.info(`tcp server listening on ${this.config.host}:${this.config.port}`);
  }

  /**
   * stop the tcp server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('stopping tcp server');

    // stop ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    // disconnect all peers
    for (const peer of this.peers.values()) {
      peer.disconnect();
    }
    this.peers.clear();

    // close server
    if (this.server) {
      this.server.stop();
      this.server = undefined;
    }

    this.isRunning = false;
    logger.info('tcp server stopped');
  }

  /**
   * connect to a peer
   */
  async connectToPeer(address: string, port: number): Promise<void> {
    const peerId = `${address}:${port}`;
    
    if (this.peers.has(peerId)) {
      logger.debug(`already connected to ${peerId}`);
      return;
    }

    if (this.peers.size >= this.config.maxPeers) {
      logger.warn('max peers reached, cannot connect');
      return;
    }

    logger.info(`connecting to peer ${peerId}`);

    try {
      const socket = await Bun.connect({
        hostname: address,
        port: port,
        socket: {
          open: (socket) => this.handleConnection(socket),
          close: (socket) => this.handleDisconnection(socket),
          data: (socket, data) => this.handleData(socket, data),
          error: (socket, error) => this.handleError(socket, error),
          drain: (socket) => this.handleDrain(socket),
        },
      });

      // send version message immediately
      const peer = this.peers.get(peerId);
      if (peer) {
        await peer.sendVersion();
      }
    } catch (error) {
      logger.error(`failed to connect to ${peerId}:`, error);
    }
  }

  /**
   * broadcast a message to all connected peers
   */
  broadcast(type: MessageType, payload: Uint8Array): void {
    for (const peer of this.peers.values()) {
      if (peer.state === ConnectionState.CONNECTED) {
        peer.sendMessage(type, payload);
      }
    }
  }

  /**
   * get connected peer info
   */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).map(peer => peer.getInfo());
  }

  /**
   * get peer count
   */
  getPeerCount(): number {
    return this.peers.size;
  }

  // socket handlers

  private handleConnection(socket: Socket): void {
    const address = socket.remoteAddress;
    const port = socket.data?.port || 0;
    const peerId = `${address}:${port}`;

    logger.info(`new connection from ${peerId}`);

    if (this.peers.size >= this.config.maxPeers) {
      logger.warn(`max peers reached, rejecting ${peerId}`);
      socket.end();
      return;
    }

    const peer = new PeerConnection(socket, this.protocol, peerId);
    this.peers.set(peerId, peer);

    // store peer reference in socket data
    socket.data = { peerId, peer };

    // send version message for outbound connections
    if (socket.data?.isOutbound) {
      peer.sendVersion();
    }
  }

  private handleDisconnection(socket: Socket): void {
    const peerId = socket.data?.peerId;
    if (!peerId) return;

    logger.info(`peer disconnected: ${peerId}`);
    this.peers.delete(peerId);
  }

  private handleData(socket: Socket, data: Buffer): void {
    const peer = socket.data?.peer as PeerConnection;
    if (!peer) return;

    peer.handleData(data);
  }

  private handleError(socket: Socket, error: Error): void {
    const peerId = socket.data?.peerId;
    logger.error(`socket error for ${peerId}:`, error);
    socket.end();
  }

  private handleDrain(socket: Socket): void {
    const peer = socket.data?.peer as PeerConnection;
    if (!peer) return;

    peer.handleDrain();
  }

  private pingAllPeers(): void {
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.state === ConnectionState.CONNECTED) {
        peer.sendPing();
      }

      // check for timeout
      if (now - peer.lastSeen > this.config.connectionTimeout) {
        logger.warn(`peer ${peer.id} timed out`);
        peer.disconnect();
      }
    }
  }
}

/**
 * represents a connection to a single peer
 */
class PeerConnection {
  public readonly id: string;
  public state: ConnectionState = ConnectionState.CONNECTING;
  public lastSeen: number = Date.now();
  public bytesReceived: number = 0;
  public bytesSent: number = 0;

  private socket: Socket;
  private protocol: Protocol;
  private buffer: Uint8Array = new Uint8Array(0);
  private writeQueue: Uint8Array[] = [];
  private isWriting = false;

  // peer info from version message
  public version?: number;
  public userAgent?: string;
  public startHeight?: number;
  public services?: bigint;

  // ping/pong
  private pingNonce?: bigint;
  private pingTime?: number;

  constructor(socket: Socket, protocol: Protocol, id: string) {
    this.socket = socket;
    this.protocol = protocol;
    this.id = id;
    this.state = ConnectionState.HANDSHAKING;
  }

  /**
   * send version message
   */
  async sendVersion(): Promise<void> {
    const versionMsg: VersionMessage = {
      version: PROTOCOL_VERSION,
      services: 1n, // node network
      timestamp: Math.floor(Date.now() / 1000),
      addrRecv: this.socket.remoteAddress,
      addrFrom: this.socket.localAddress || '0.0.0.0',
      nonce: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
      userAgent: 'bolt/1.0.0',
      startHeight: 0, // todo: get from blockchain
    };

    const payload = this.protocol.serializeVersion(versionMsg);
    await this.sendMessage(MessageType.VERSION, payload);
  }

  /**
   * send a message
   */
  async sendMessage(type: MessageType, payload: Uint8Array): Promise<void> {
    const message = this.protocol.serializeMessage(type, payload);
    this.bytesSent += message.length;

    // queue write if already writing
    if (this.isWriting) {
      this.writeQueue.push(message);
      return;
    }

    this.isWriting = true;
    const written = this.socket.write(message);

    if (!written) {
      // socket buffer full, queue for drain
      this.writeQueue.push(message);
    }

    this.isWriting = false;
  }

  /**
   * send ping
   */
  sendPing(): void {
    this.pingNonce = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    this.pingTime = Date.now();
    const payload = this.protocol.serializePing(this.pingNonce);
    this.sendMessage(MessageType.PING, payload);
  }

  /**
   * handle incoming data
   */
  handleData(data: Buffer): void {
    this.lastSeen = Date.now();
    this.bytesReceived += data.length;

    // append to buffer
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(new Uint8Array(data), this.buffer.length);
    this.buffer = newBuffer;

    // process messages
    this.processMessages();
  }

  /**
   * handle socket drain
   */
  handleDrain(): void {
    // write queued messages
    while (this.writeQueue.length > 0) {
      const message = this.writeQueue.shift()!;
      const written = this.socket.write(message);
      if (!written) {
        // still full, re-queue
        this.writeQueue.unshift(message);
        break;
      }
    }
  }

  /**
   * process messages from buffer
   */
  private processMessages(): void {
    while (this.buffer.length >= 16) {
      const result = this.protocol.deserializeMessage(this.buffer);
      if (!result) break;

      const { header, payload } = result;
      
      // remove processed message from buffer
      this.buffer = this.buffer.slice(16 + header.length);

      // handle message
      this.handleMessage(header.type, payload);
    }
  }

  /**
   * handle a message
   */
  private handleMessage(type: MessageType, payload: Uint8Array): void {
    logger.debug(`received ${MessageType[type]} from ${this.id}`);

    switch (type) {
      case MessageType.VERSION:
        this.handleVersion(payload);
        break;
      case MessageType.VERACK:
        this.handleVerack();
        break;
      case MessageType.PING:
        this.handlePing(payload);
        break;
      case MessageType.PONG:
        this.handlePong(payload);
        break;
      // todo: handle other message types
      default:
        logger.debug(`unhandled message type: ${MessageType[type]}`);
    }
  }

  private handleVersion(payload: Uint8Array): void {
    const version = this.protocol.deserializeVersion(payload);
    if (!version) {
      logger.warn('invalid version message');
      this.disconnect();
      return;
    }

    this.version = version.version;
    this.userAgent = version.userAgent;
    this.startHeight = version.startHeight;
    this.services = version.services;

    // send verack
    this.sendMessage(MessageType.VERACK, new Uint8Array(0));

    if (this.state === ConnectionState.HANDSHAKING) {
      // wait for verack
    }
  }

  private handleVerack(): void {
    if (this.state === ConnectionState.HANDSHAKING) {
      this.state = ConnectionState.CONNECTED;
      logger.info(`handshake complete with ${this.id}`);
    }
  }

  private handlePing(payload: Uint8Array): void {
    const nonce = this.protocol.deserializePing(payload);
    if (nonce === null) return;

    // send pong with same nonce
    const pongPayload = this.protocol.serializePing(nonce);
    this.sendMessage(MessageType.PONG, pongPayload);
  }

  private handlePong(payload: Uint8Array): void {
    const nonce = this.protocol.deserializePing(payload);
    if (nonce === null) return;

    if (this.pingNonce && nonce === this.pingNonce && this.pingTime) {
      const latency = Date.now() - this.pingTime;
      logger.debug(`ping latency to ${this.id}: ${latency}ms`);
      this.pingNonce = undefined;
      this.pingTime = undefined;
    }
  }

  /**
   * disconnect from peer
   */
  disconnect(): void {
    if (this.state === ConnectionState.DISCONNECTED) return;
    
    this.state = ConnectionState.DISCONNECTING;
    this.socket.end();
    this.state = ConnectionState.DISCONNECTED;
  }

  /**
   * get peer info
   */
  getInfo(): PeerInfo {
    const [address, portStr] = this.id.split(':');
    return {
      id: this.id,
      address,
      port: parseInt(portStr) || 0,
      state: this.state,
      version: this.version,
      userAgent: this.userAgent,
      startHeight: this.startHeight,
      lastSeen: this.lastSeen,
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
    };
  }
}