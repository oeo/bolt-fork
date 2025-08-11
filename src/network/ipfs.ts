import { create, IPFSHTTPClient } from 'ipfs-http-client';
import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import { serialize, deserialize } from '../utils/bigint';
import type { ChainConfig } from '../config/chain';

const logger = getLogger(__filename);

export interface IPFSConfig {
  apiUrl?: string;
  nodeId: string;
  chainConfig: ChainConfig;
}

export interface IPFSMessage {
  type: string;
  data: any;
  nodeId: string;
  httpUrl?: string;
  timestamp: number;
}

interface IPFSStats {
  messagesReceived: number;
  messagesSent: number;
  peersConnected: number;
  blocksReceived: number;
  txReceived: number;
  startTime: number;
}

/**
 * ipfs-based p2p networking service
 * replaces complex libp2p setup with simple ipfs pubsub
 */
export class IPFSService extends EventEmitter {
  private ipfs: IPFSHTTPClient | null = null;
  private config: IPFSConfig;
  private topics: Map<string, any> = new Map();
  private peers: Set<string> = new Set();
  private discoveredPeers: Array<{nodeId: string, httpUrl: string}> = [];
  private isStarted: boolean = false;
  
  private stats: IPFSStats = {
    messagesReceived: 0,
    messagesSent: 0,
    peersConnected: 0,
    blocksReceived: 0,
    txReceived: 0,
    startTime: Date.now()
  };
  
  // only peer discovery topic now
  public static readonly TOPIC_PEERS = 'bolt-peers';
  
  constructor(config: IPFSConfig) {
    super();
    this.config = config;
  }
  
  
  /**
   * start the ipfs p2p service
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      logger.warn('IPFS service already started');
      return;
    }
    
    logger.info(`Starting IPFS P2P service (node: ${this.config.nodeId})`);
    
    try {
      // connect to ipfs daemon
      const apiUrl = this.config.apiUrl || process.env.IPFS_API || 'http://localhost:5001';
      this.ipfs = create({ url: apiUrl });
      
      // verify ipfs connection
      const id = await this.ipfs.id();
      logger.info(`Connected to IPFS node: ${id.id}`);
      
      // subscribe only to peer discovery topic
      await this.subscribeToTopic(IPFSService.TOPIC_PEERS);
      
      // mark as started before announcing
      this.isStarted = true;
      
      // announce this node to the network
      await this.announceNode();
      
      // start peer discovery
      this.startPeerDiscovery();
      
      logger.info('IPFS P2P service started successfully');
      
    } catch (error: any) {
      logger.error('Failed to start IPFS P2P service:', error);
      logger.info('Ensure IPFS daemon is running: ipfs daemon --enable-pubsub-experiment');
      throw error;
    }
  }
  
  /**
   * stop the ipfs p2p service
   */
  async stop(): Promise<void> {
    if (!this.isStarted || !this.ipfs) {
      return;
    }
    
    logger.info('Stopping IPFS P2P service');
    
    try {
      // unsubscribe from all topics
      for (const topic of this.topics.keys()) {
        await this.ipfs.pubsub.unsubscribe(topic);
      }
      
      this.topics.clear();
      this.peers.clear();
      this.isStarted = false;
      this.ipfs = null;
      
      logger.info('IPFS P2P service stopped');
    } catch (error: any) {
      logger.error('Error stopping IPFS P2P service:', error);
    }
  }
  
  /**
   * subscribe to an ipfs pubsub topic
   */
  private async subscribeToTopic(topic: string): Promise<void> {
    if (!this.ipfs) return;
    
    try {
      const handler = (msg: any) => {
        this.handleMessage(topic, msg);
      };
      
      await this.ipfs.pubsub.subscribe(topic, handler);
      this.topics.set(topic, handler);
      logger.info(`Subscribed to topic: ${topic}`);
      
    } catch (error: any) {
      logger.error(`Failed to subscribe to topic ${topic}:`, error);
    }
  }
  
  /**
   * handle incoming ipfs message
   */
  private handleMessage(topic: string, msg: any): void {
    try {
      this.stats.messagesReceived++;
      
      // parse with BigInt support using utility
      const messageText = new TextDecoder().decode(msg.data);
      const data = deserialize(messageText);
      const senderId = msg.from;
      
      // track peer
      this.peers.add(senderId);
      this.stats.peersConnected = this.peers.size;
      
      
      // only handle peer announcements now
      if (topic === IPFSService.TOPIC_PEERS) {
        // track discovered peer with HTTP endpoint
        if (data.httpUrl && data.nodeId !== this.config.nodeId) {
          const existingPeer = this.discoveredPeers.find(p => p.nodeId === data.nodeId);
          if (!existingPeer) {
            this.discoveredPeers.push({
              nodeId: data.nodeId,
              httpUrl: data.httpUrl
            });
            logger.info(`Discovered new peer: ${data.nodeId} at ${data.httpUrl}`);
          }
        }
        this.emit('peer', data);
      }
      
    } catch (error: any) {
      logger.error(`Failed to handle message from ${topic}:`, error);
    }
  }
  
  /**
   * announce this node to the network
   */
  async announceNode(): Promise<void> {
    // get our HTTP API endpoint
    const apiPort = process.env.API_PORT || '7333';
    const nodeHost = process.env.NODE_HOST || this.config.nodeId;
    const httpUrl = `http://${nodeHost}:${apiPort}`;
    
    const announcement: IPFSMessage = {
      type: 'node_announcement',
      nodeId: this.config.nodeId,
      httpUrl,
      timestamp: Date.now(),
      data: {
        capabilities: ['blockchain', 'mining'],
        version: '0.1.0',
        role: process.env.NODE_ROLE || 'full'
      }
    };
    
    await this.publishToTopic(IPFSService.TOPIC_PEERS, announcement);
    logger.info(`Announced node: ${this.config.nodeId} at ${httpUrl}`);
  }
  
  // block and transaction announcements removed - will use HTTP directly
  
  /**
   * publish message to ipfs topic
   */
  private async publishToTopic(topic: string, data: any): Promise<boolean> {
    if (!this.ipfs || !this.isStarted) {
      logger.warn(`IPFS not ready, cannot publish to ${topic}`);
      return false;
    }
    
    try {
      // serialize with BigInt support using utility
      const message = serialize(data);
      const uint8Array = new TextEncoder().encode(message);
      await this.ipfs.pubsub.publish(topic, uint8Array);
      this.stats.messagesSent++;
      
      logger.debug(`Published to ${topic}: ${data.type}`);
      return true;
      
    } catch (error: any) {
      logger.error(`Failed to publish to ${topic}:`, error);
      return false;
    }
  }
  
  /**
   * start periodic peer discovery
   */
  private startPeerDiscovery(): void {
    // periodic peer discovery via ipfs swarm
    setInterval(async () => {
      await this.discoverPeers();
    }, 30000); // every 30 seconds
    
    // announce ourselves periodically
    setInterval(async () => {
      await this.announceNode();
    }, 60000); // every minute
  }
  
  /**
   * discover peers via ipfs swarm
   */
  private async discoverPeers(): Promise<void> {
    if (!this.ipfs) return;
    
    try {
      // get peers from ipfs swarm
      const peers = await this.ipfs.swarm.peers();
      
      for (const peer of peers) {
        this.peers.add(peer.peer.toString());
      }
      
      this.stats.peersConnected = this.peers.size;
      logger.debug(`Discovered ${this.peers.size} peers via IPFS`);
      
    } catch (error: any) {
      logger.error('Peer discovery error:', error);
    }
  }
  
  /**
   * get service statistics
   */
  getStats(): any {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      isConnected: this.isStarted,
      nodeId: this.config.nodeId,
      peersCount: this.peers.size,
      peers: Array.from(this.peers).map(peerId => ({ id: peerId })),
      networkType: 'ipfs'
    };
  }
  
  /**
   * get discovered peers with their HTTP endpoints
   */
  getDiscoveredPeers(): Array<{nodeId: string, httpUrl: string}> {
    return this.discoveredPeers || [];
  }
  
  /**
   * get connected IPFS peers
   */
  getPeers(): string[] {
    return Array.from(this.peers);
  }
  
  /**
   * check if service is started
   */
  isRunning(): boolean {
    return this.isStarted;
  }
}