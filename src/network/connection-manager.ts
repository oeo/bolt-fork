import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Socket, Server } from 'bun';
import type { PeerEndpoint } from './peer-discovery';

const logger = getLogger(__filename);

export interface PeerConnection {
  id: string; // node id
  socket: Socket;
  endpoint: string; // tcp address
  inbound: boolean;
  connected: boolean;
  lastSeen: number;
  version?: string;
  height?: number;
  chainHash?: string;
  messageBuffer: Uint8Array;
}

export interface ConnectionManagerConfig {
  nodeId: string;
  tcpPort: number;
  maxConnections?: number;
  connectionTimeout?: number; // ms
  messageTimeout?: number; // ms
}

/**
 * manages tcp connections to peers using bun's native tcp
 */
export class ConnectionManager extends EventEmitter {
  private config: ConnectionManagerConfig;
  private server: Server | null = null;
  private connections: Map<string, PeerConnection> = new Map();
  private socketToId: Map<Socket, string> = new Map();
  private isRunning: boolean = false;
  
  constructor(config: ConnectionManagerConfig) {
    super();
    this.config = {
      maxConnections: 125,
      connectionTimeout: 30000,
      messageTimeout: 60000,
      ...config
    };
  }
  
  /**
   * start tcp server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('connection manager already running');
      return;
    }
    
    try {
      // create bun tcp server
      this.server = Bun.listen({
        hostname: '0.0.0.0',
        port: this.config.tcpPort,
        socket: {
          data: (socket, data) => this.handleData(socket, data),
          open: (socket) => this.handleNewConnection(socket, true),
          close: (socket) => this.handleDisconnection(socket),
          drain: (socket) => this.handleBackpressure(socket),
          error: (socket, error) => this.handleError(socket, error)
        }
      });
      
      this.isRunning = true;
      logger.info(`tcp server listening on port ${this.config.tcpPort}`);
      
      // start connection health checker
      this.startHealthCheck();
      
    } catch (error) {
      logger.error('failed to start tcp server:', error);
      throw error;
    }
  }
  
  /**
   * stop tcp server and close all connections
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    logger.info('stopping connection manager');
    
    // close all connections
    for (const [id, conn] of this.connections) {
      try {
        conn.socket.end();
      } catch (error) {
        logger.debug(`error closing connection ${id}:`, error);
      }
    }
    
    // stop server
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    
    this.connections.clear();
    this.socketToId.clear();
    this.isRunning = false;
    
    logger.info('connection manager stopped');
  }
  
  /**
   * connect to a discovered peer
   */
  async connectToPeer(endpoint: PeerEndpoint): Promise<boolean> {
    // check if already connected
    if (this.connections.has(endpoint.nodeId)) {
      logger.debug(`already connected to ${endpoint.nodeId}`);
      return true;
    }
    
    // check connection limit
    if (this.connections.size >= this.config.maxConnections!) {
      logger.debug('max connections reached');
      return false;
    }
    
    try {
      const [host, port] = endpoint.tcp.split(':');
      
      logger.info(`connecting to ${endpoint.nodeId} at ${endpoint.tcp}`);
      
      const socket = await Bun.connect({
        hostname: host,
        port: parseInt(port),
        socket: {
          data: (socket, data) => this.handleData(socket, data),
          open: (socket) => {
            this.handleNewConnection(socket, false, endpoint.nodeId);
            // send version message after connection
            this.emit('connection:ready', endpoint.nodeId);
          },
          close: (socket) => this.handleDisconnection(socket),
          drain: (socket) => this.handleBackpressure(socket),
          error: (socket, error) => this.handleError(socket, error),
          timeout: (socket) => this.handleTimeout(socket)
        }
      });
      
      return true;
      
    } catch (error) {
      logger.error(`failed to connect to ${endpoint.nodeId}:`, error);
      return false;
    }
  }
  
  /**
   * handle new connection (inbound or outbound)
   */
  private handleNewConnection(socket: Socket, inbound: boolean, nodeId?: string): void {
    // generate temporary id for inbound connections
    const connId = nodeId || `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const connection: PeerConnection = {
      id: connId,
      socket: socket,
      endpoint: socket.remoteAddress || 'unknown',
      inbound: inbound,
      connected: true,
      lastSeen: Date.now(),
      messageBuffer: new Uint8Array(0)
    };
    
    this.connections.set(connId, connection);
    this.socketToId.set(socket, connId);
    
    logger.info(`${inbound ? 'accepted' : 'established'} connection ${connId} from ${connection.endpoint}`);
    this.emit('peer:connected', connId, inbound);
  }
  
  /**
   * handle incoming data from socket
   */
  private handleData(socket: Socket, data: Uint8Array): void {
    const connId = this.socketToId.get(socket);
    if (!connId) {
      logger.warn('received data from unknown socket');
      return;
    }
    
    const connection = this.connections.get(connId);
    if (!connection) {
      logger.warn(`no connection found for ${connId}`);
      return;
    }
    
    // update last seen
    connection.lastSeen = Date.now();
    
    // append to message buffer
    const prevBuffer = connection.messageBuffer;
    const newBuffer = new Uint8Array(prevBuffer.length + data.length);
    newBuffer.set(prevBuffer);
    newBuffer.set(data, prevBuffer.length);
    connection.messageBuffer = newBuffer;
    
    // try to extract complete messages
    this.processMessageBuffer(connection);
  }
  
  /**
   * process buffered data to extract complete messages
   */
  private processMessageBuffer(connection: PeerConnection): void {
    let offset = 0;
    const buffer = connection.messageBuffer;
    
    // minimum message size is 24 bytes (header)
    while (offset + 24 <= buffer.length) {
      // peek at message length (bytes 16-19)
      const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 16, 4);
      const payloadLength = view.getUint32(0, false); // big-endian
      
      const messageLength = 24 + payloadLength;
      
      // check if we have complete message
      if (offset + messageLength <= buffer.length) {
        // extract message
        const message = buffer.slice(offset, offset + messageLength);
        
        // emit for protocol handler
        this.emit('message:received', connection.id, message);
        
        offset += messageLength;
      } else {
        // incomplete message, wait for more data
        break;
      }
    }
    
    // keep remaining partial message
    if (offset > 0) {
      connection.messageBuffer = buffer.slice(offset);
    }
  }
  
  /**
   * send message to peer
   */
  sendMessage(nodeId: string, data: Uint8Array): boolean {
    const connection = this.connections.get(nodeId);
    if (!connection || !connection.connected) {
      logger.warn(`cannot send to ${nodeId}: not connected`);
      return false;
    }
    
    try {
      const written = connection.socket.write(data);
      if (written < data.length) {
        logger.warn(`partial write to ${nodeId}: ${written}/${data.length} bytes`);
        // bun will buffer the rest
      }
      return true;
    } catch (error) {
      logger.error(`failed to send to ${nodeId}:`, error);
      this.handleDisconnection(connection.socket);
      return false;
    }
  }
  
  /**
   * handle socket disconnection
   */
  private handleDisconnection(socket: Socket): void {
    const connId = this.socketToId.get(socket);
    if (!connId) return;
    
    const connection = this.connections.get(connId);
    if (connection) {
      connection.connected = false;
      logger.info(`disconnected from ${connId}`);
      this.emit('peer:disconnected', connId);
    }
    
    this.connections.delete(connId);
    this.socketToId.delete(socket);
  }
  
  /**
   * handle socket error
   */
  private handleError(socket: Socket, error: Error): void {
    const connId = this.socketToId.get(socket);
    logger.error(`socket error for ${connId}:`, error);
    this.handleDisconnection(socket);
  }
  
  /**
   * handle socket timeout
   */
  private handleTimeout(socket: Socket): void {
    const connId = this.socketToId.get(socket);
    logger.warn(`socket timeout for ${connId}`);
    this.handleDisconnection(socket);
  }
  
  /**
   * handle backpressure (socket buffer full)
   */
  private handleBackpressure(socket: Socket): void {
    const connId = this.socketToId.get(socket);
    logger.debug(`backpressure relieved for ${connId}`);
    // socket is ready to write again
    this.emit('socket:drain', connId);
  }
  
  /**
   * update peer info after version handshake
   */
  updatePeerInfo(nodeId: string, info: {
    version?: string;
    height?: number;
    chainHash?: string;
    actualNodeId?: string; // for renaming temp connections
  }): void {
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    
    if (info.version) connection.version = info.version;
    if (info.height !== undefined) connection.height = info.height;
    if (info.chainHash) connection.chainHash = info.chainHash;
    
    // rename temporary connection
    if (info.actualNodeId && nodeId.startsWith('temp-')) {
      this.connections.delete(nodeId);
      connection.id = info.actualNodeId;
      this.connections.set(info.actualNodeId, connection);
      this.socketToId.set(connection.socket, info.actualNodeId);
      logger.info(`renamed connection ${nodeId} to ${info.actualNodeId}`);
    }
  }
  
  /**
   * disconnect a specific peer
   */
  disconnect(nodeId: string, reason?: string): void {
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    
    logger.info(`disconnecting ${nodeId}: ${reason || 'requested'}`);
    
    try {
      connection.socket.end();
    } catch (error) {
      logger.debug(`error disconnecting ${nodeId}:`, error);
    }
    
    this.handleDisconnection(connection.socket);
  }
  
  /**
   * periodic health check for connections
   */
  private startHealthCheck(): void {
    setInterval(() => {
      const now = Date.now();
      const timeout = this.config.messageTimeout!;
      
      for (const [id, conn] of this.connections) {
        if (now - conn.lastSeen > timeout) {
          logger.warn(`connection ${id} timed out`);
          this.disconnect(id, 'timeout');
        }
      }
    }, 30000); // check every 30 seconds
  }
  
  /**
   * get all connected peers
   */
  getConnectedPeers(): string[] {
    return Array.from(this.connections.keys());
  }
  
  /**
   * get connection info
   */
  getConnection(nodeId: string): PeerConnection | undefined {
    return this.connections.get(nodeId);
  }
  
  /**
   * check if connected to peer
   */
  isConnected(nodeId: string): boolean {
    const conn = this.connections.get(nodeId);
    return conn?.connected || false;
  }
  
  /**
   * get connection stats
   */
  getStats(): {
    totalConnections: number;
    inboundConnections: number;
    outboundConnections: number;
    maxConnections: number;
  } {
    let inbound = 0;
    let outbound = 0;
    
    for (const conn of this.connections.values()) {
      if (conn.inbound) inbound++;
      else outbound++;
    }
    
    return {
      totalConnections: this.connections.size,
      inboundConnections: inbound,
      outboundConnections: outbound,
      maxConnections: this.config.maxConnections!
    };
  }
}