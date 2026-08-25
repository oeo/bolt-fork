import { EventEmitter } from 'events';
import { create, multiaddr, type KuboRPCClient } from 'kubo-rpc-client';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export interface PeerEndpoint {
  nodeId: string;
  tcp: string; // host:port for tcp connection
  height: number;
  chainHash: string;
  version: string;
  timestamp: number;
  capabilities?: string[];
}

export interface PeerDiscoveryConfig {
  nodeId: string;
  tcpHost: string;
  tcpPort: number;
  ipfsApi?: string;
  announceInterval?: number; // ms
  cleanupInterval?: number; // ms
  peerTimeout?: number; // ms
}

/**
 * peer discovery service using ipfs pubsub
 * only announces tcp endpoints, no blockchain data on ipfs
 */
export class PeerDiscoveryService extends EventEmitter {
  private config: PeerDiscoveryConfig;
  private ipfs: KuboRPCClient | null = null;
  private knownPeers: Map<string, PeerEndpoint> = new Map();
  private announceTimer: any;
  private cleanupTimer: any;
  private isRunning: boolean = false;
  
  // ipfs topic for peer discovery only
  private static readonly DISCOVERY_TOPIC = '/bolt/peers';
  
  // ipfs bootstrap nodes for network connectivity
  private static readonly BOOTSTRAP_NODES = [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
  ];
  
  constructor(config: PeerDiscoveryConfig) {
    super();
    this.config = {
      announceInterval: 30000, // 30 seconds
      cleanupInterval: 60000, // 1 minute
      peerTimeout: 120000, // 2 minutes
      ipfsApi: process.env.IPFS_API || 'http://localhost:5001',
      ...config
    };
  }
  
  /**
   * start peer discovery service
   */
  async start(chainHeight: number, chainHash: string): Promise<void> {
    if (this.isRunning) {
      logger.warn('peer discovery already running');
      return;
    }
    
    try {
      // connect to ipfs
      this.ipfs = create({ url: this.config.ipfsApi });
      const id = await this.ipfs.id();
      logger.info(`connected to ipfs node: ${id.id}`);
      
      // connect to bootstrap nodes for network connectivity
      await this.connectToBootstrapNodes();
      
      // subscribe to peer discovery topic
      await this.subscribeToPeers();
      
      this.isRunning = true;
      
      // start announcing ourselves
      this.startAnnouncing(chainHeight, chainHash);
      
      // start cleanup of stale peers
      this.startCleanup();
      
      logger.info('peer discovery service started');
    } catch (error) {
      logger.error('failed to start peer discovery:', error);
      throw error;
    }
  }
  
  /**
   * stop peer discovery service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    logger.info('stopping peer discovery service');
    
    // stop timers
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    // unsubscribe from ipfs
    if (this.ipfs) {
      try {
        await this.ipfs.pubsub.unsubscribe(PeerDiscoveryService.DISCOVERY_TOPIC);
      } catch (error) {
        logger.error('error unsubscribing:', error);
      }
      this.ipfs = null;
    }
    
    this.knownPeers.clear();
    this.isRunning = false;
    
    logger.info('peer discovery service stopped');
  }
  
  /**
   * connect to bootstrap nodes for network connectivity
   */
  private async connectToBootstrapNodes(): Promise<void> {
    if (!this.ipfs) return;
    
    logger.info('connecting to ipfs bootstrap nodes');
    let connected = 0;
    
    for (const addr of PeerDiscoveryService.BOOTSTRAP_NODES) {
      try {
        await this.ipfs.swarm.connect(multiaddr(addr));
        connected++;
        logger.debug(`connected to bootstrap: ${addr.split('/').pop()}`);
      } catch (error) {
        // ignore connection errors, some nodes may be offline
        logger.debug(`failed to connect to bootstrap: ${addr}`);
      }
    }
    
    logger.info(`connected to ${connected} bootstrap nodes`);
  }
  
  /**
   * subscribe to peer announcements
   */
  private async subscribeToPeers(): Promise<void> {
    if (!this.ipfs) return;
    
    const handler = (msg: any) => {
      console.log(`[DISCOVERY] Received message on topic`);
      try {
        const data = JSON.parse(new TextDecoder().decode(msg.data));
        console.log(`[DISCOVERY] Decoded announcement from ${data.nodeId}`);
        
        // ignore our own announcements
        if (data.nodeId === this.config.nodeId) {
          console.log(`[DISCOVERY] Ignoring own announcement`);
          return;
        }
        
        // validate peer endpoint
        if (!this.validatePeerEndpoint(data)) {
          logger.debug(`invalid peer announcement from ${data.nodeId}`);
          return;
        }
        
        const peer: PeerEndpoint = {
          nodeId: data.nodeId,
          tcp: data.tcp,
          height: data.height,
          chainHash: data.chainHash,
          version: data.version,
          timestamp: Date.now(), // use local timestamp
          capabilities: data.capabilities
        };
        
        // check if new or updated peer
        const existing = this.knownPeers.get(peer.nodeId);
        if (!existing) {
          logger.info(`discovered new peer: ${peer.nodeId} at ${peer.tcp}`);
          this.knownPeers.set(peer.nodeId, peer);
          this.emit('peer:discovered', peer);
        } else if (existing.height !== peer.height || existing.chainHash !== peer.chainHash) {
          logger.debug(`peer updated: ${peer.nodeId} height=${peer.height}`);
          this.knownPeers.set(peer.nodeId, peer);
          this.emit('peer:updated', peer);
        } else {
          // just update timestamp
          existing.timestamp = Date.now();
        }
        
      } catch (error) {
        logger.debug('invalid peer announcement:', error);
      }
    };
    
    console.log(`[DISCOVERY] Subscribing to topic: ${PeerDiscoveryService.DISCOVERY_TOPIC}`);
    await this.ipfs.pubsub.subscribe(PeerDiscoveryService.DISCOVERY_TOPIC, handler);
    console.log(`[DISCOVERY] Successfully subscribed to ${PeerDiscoveryService.DISCOVERY_TOPIC}`);
    logger.info(`subscribed to ${PeerDiscoveryService.DISCOVERY_TOPIC}`);
  }
  
  /**
   * start announcing our tcp endpoint
   */
  private startAnnouncing(initialHeight: number, initialHash: string): void {
    logger.info(`starting announcements for tcp endpoint ${this.config.tcpHost}:${this.config.tcpPort}`);
    
    let currentHeight = initialHeight;
    let currentHash = initialHash;
    
    // allow updating chain info
    this.on('chain:updated', ({ height, hash }) => {
      currentHeight = height;
      currentHash = hash;
    });
    
    const announce = async () => {
      if (!this.ipfs || !this.isRunning) {
        logger.warn('cannot announce: ipfs not ready or service not running');
        return;
      }
      
      const announcement = {
        nodeId: this.config.nodeId,
        tcp: `${this.config.tcpHost}:${this.config.tcpPort}`,
        height: currentHeight,
        chainHash: currentHash,
        version: '1.0.0',
        timestamp: Date.now(),
        capabilities: ['full_node', 'mining']
      };
      
      try {
        console.log(`[DISCOVERY] Publishing announcement: ${JSON.stringify(announcement)}`);
        const data = new TextEncoder().encode(JSON.stringify(announcement));
        await this.ipfs.pubsub.publish(PeerDiscoveryService.DISCOVERY_TOPIC, data);
        console.log(`[DISCOVERY] Announcement published successfully`);
        logger.info(`announced tcp endpoint: ${announcement.tcp} (height=${currentHeight})`);
      } catch (error) {
        console.log(`[DISCOVERY] Failed to publish announcement:`, error);
        logger.error('failed to announce:', error);
      }
    };
    
    // announce immediately
    logger.info('sending initial announcement');
    announce();
    
    // then periodically
    logger.info(`setting up periodic announcements every ${this.config.announceInterval}ms`);
    this.announceTimer = setInterval(announce, this.config.announceInterval);
  }
  
  /**
   * start cleanup of stale peers
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.peerTimeout!;
      
      for (const [nodeId, peer] of this.knownPeers) {
        if (now - peer.timestamp > timeout) {
          logger.info(`removing stale peer: ${nodeId}`);
          this.knownPeers.delete(nodeId);
          this.emit('peer:removed', peer);
        }
      }
    }, this.config.cleanupInterval);
  }
  
  /**
   * validate peer endpoint data
   */
  private validatePeerEndpoint(data: any): boolean {
    if (!data.nodeId || typeof data.nodeId !== 'string') return false;
    if (!data.tcp || typeof data.tcp !== 'string') return false;
    if (typeof data.height !== 'number' || data.height < 0) return false;
    if (!data.chainHash || typeof data.chainHash !== 'string') return false;
    if (!data.version || typeof data.version !== 'string') return false;
    
    // validate tcp format (host:port)
    const tcpParts = data.tcp.split(':');
    if (tcpParts.length !== 2) return false;
    const port = parseInt(tcpParts[1]);
    if (isNaN(port) || port < 1 || port > 65535) return false;
    
    return true;
  }
  
  /**
   * update our chain info for announcements
   */
  updateChainInfo(height: number, hash: string): void {
    this.emit('chain:updated', { height, hash });
  }
  
  /**
   * get all known peers
   */
  getKnownPeers(): PeerEndpoint[] {
    return Array.from(this.knownPeers.values());
  }
  
  /**
   * get peer by node id
   */
  getPeer(nodeId: string): PeerEndpoint | undefined {
    return this.knownPeers.get(nodeId);
  }
  
  /**
   * get best peer (highest work)
   */
  getBestPeer(): PeerEndpoint | null {
    const peers = this.getKnownPeers();
    if (peers.length === 0) return null;
    
    // for now, just use highest block height
    // later we'll compare cumulative difficulty
    return peers.reduce((best, peer) => {
      return peer.height > best.height ? peer : best;
    });
  }
  
  /**
   * check if service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
  
  /**
   * get discovery stats
   */
  getStats(): {
    peersDiscovered: number;
    isRunning: boolean;
    announceInterval: number;
    lastAnnounce?: number;
  } {
    return {
      peersDiscovered: this.knownPeers.size,
      isRunning: this.isRunning,
      announceInterval: this.config.announceInterval!,
    };
  }
}
