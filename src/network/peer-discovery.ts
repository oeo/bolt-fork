import { EventEmitter } from 'events';
import { create, multiaddr, type KuboRPCClient, type Message } from 'kubo-rpc-client';
import { getLogger } from '../utils/logger';
import { publicKeyMatchesAddress, validateAddress } from '../crypto/address';
import { sign, verify } from '../crypto/signature';
import { encodeCanonicalFields } from '../utils/serialization';
import { PROTOCOL_VERSION } from './protocol';
import type { NodeIdentity } from '../utils/identity';

const logger = getLogger(__filename);

export interface PeerEndpoint {
  nodeId: string;
  publicKey: string;
  tcp: string; // host:port for tcp connection
  height: number;
  tipHash: string;
  chainId: number;
  genesisHash: string;
  version: string;
  timestamp: number;
  lastSeen: number;
  capabilities?: string[];
  signature: string;
}

export function parsePeerEndpoint(endpoint: string): { host: string; port: number } | null {
  const match = endpoint.match(/^\[([^\]]+)]:(\d+)$|^([^:]+):(\d+)$/);
  if (!match) return null;
  const host = match[1] || match[3];
  const port = Number(match[2] || match[4]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
}

function formatPeerEndpoint(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export interface PeerDiscoveryConfig {
  identity: NodeIdentity;
  chainId: number;
  genesisHash: string;
  addressPrefix: number;
  tcpHost: string;
  tcpPort: number;
  ipfsApi?: string;
  bootstrap?: boolean;
  announceInterval?: number; // ms
  cleanupInterval?: number; // ms
  peerTimeout?: number; // ms
  maxKnownPeers?: number;
  maxAnnouncementsPerMinute?: number;
  maxTotalAnnouncementsPerMinute?: number;
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
  private chainUpdateHandler?: (update: { height: number; hash: string }) => void;
  private isRunning: boolean = false;
  private isStarting = false;
  private announcementWindows = new Map<string, { startedAt: number; count: number }>();
  private totalAnnouncementWindow = { startedAt: Date.now(), count: 0 };
  private runGeneration = 0;
  
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
      maxKnownPeers: 1000,
      maxAnnouncementsPerMinute: 30,
      maxTotalAnnouncementsPerMinute: 1000,
      bootstrap: true,
      ipfsApi: process.env.IPFS_API || 'http://localhost:5001',
      ...config
    };
  }

  private get discoveryTopic(): string {
    return `/bolt/${this.config.chainId}/${this.config.genesisHash}/peers/${PROTOCOL_VERSION}`;
  }
  
  /**
   * start peer discovery service
   */
  async start(chainHeight: number, chainHash: string): Promise<void> {
    if (this.isRunning || this.isStarting) {
      logger.warn('peer discovery already running or starting');
      return;
    }
    
    const generation = ++this.runGeneration;
    this.isStarting = true;
    let client: KuboRPCClient | null = null;
    try {
      // connect to ipfs
      client = create({ url: this.config.ipfsApi });
      this.ipfs = client;
      const id = await client.id();
      if (generation !== this.runGeneration) throw new Error('peer discovery start cancelled');
      logger.info(`connected to ipfs node: ${id.id}`);
      
      // connect to bootstrap nodes for network connectivity
      if (this.config.bootstrap) await this.connectToBootstrapNodes(client);
      if (generation !== this.runGeneration) throw new Error('peer discovery start cancelled');
      
      // subscribe to peer discovery topic
      await this.subscribeToPeers(client, generation);
      if (generation !== this.runGeneration) throw new Error('peer discovery start cancelled');
      
      this.isRunning = true;
      
      // start announcing ourselves
      this.startAnnouncing(chainHeight, chainHash);
      
      // start cleanup of stale peers
      this.startCleanup();
      
      logger.info('peer discovery service started');
    } catch (error) {
      logger.error('failed to start peer discovery:', error);
      if (generation === this.runGeneration && this.ipfs === client) await this.stop();
      throw error;
    } finally {
      if (generation === this.runGeneration) this.isStarting = false;
    }
  }
  
  /**
   * stop peer discovery service
   */
  async stop(): Promise<void> {
    if (!this.isRunning && !this.ipfs) return;
    
    logger.info('stopping peer discovery service');
    const generation = ++this.runGeneration;
    const client = this.ipfs;
    this.isStarting = false;
    
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
    if (client) {
      try {
        await client.pubsub.unsubscribe(this.discoveryTopic);
      } catch (error) {
        logger.error('error unsubscribing:', error);
      }
    }
    if (generation !== this.runGeneration || this.ipfs !== client) return;
    this.ipfs = null;
    
    this.knownPeers.clear();
    if (this.chainUpdateHandler) this.off('chain:updated', this.chainUpdateHandler);
    this.chainUpdateHandler = undefined;
    this.announcementWindows.clear();
    this.totalAnnouncementWindow = { startedAt: Date.now(), count: 0 };
    this.isRunning = false;
    
    logger.info('peer discovery service stopped');
  }
  
  /**
   * connect to bootstrap nodes for network connectivity
   */
  private async connectToBootstrapNodes(client: KuboRPCClient): Promise<void> {
    logger.info('connecting to ipfs bootstrap nodes');
    let connected = 0;
    
    for (const addr of PeerDiscoveryService.BOOTSTRAP_NODES) {
      try {
        await client.swarm.connect(multiaddr(addr));
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
  private async subscribeToPeers(client: KuboRPCClient, generation: number): Promise<void> {
    const handler = async (msg: Message) => {
      try {
        if (!this.isRunning || generation !== this.runGeneration) return;
        if (!(msg.data instanceof Uint8Array) || msg.data.length > 4096) return;
        const sender = msg.type === 'signed' ? msg.from.toString() : 'unsigned';
        if (!this.acceptAnnouncement(sender)) return;
        const data = JSON.parse(new TextDecoder().decode(msg.data));
        
        // ignore our own announcements
        if (data.nodeId === this.config.identity.address) return;
        if (!this.knownPeers.has(data.nodeId) && this.knownPeers.size >= this.config.maxKnownPeers!) return;
        
        // validate peer endpoint
        if (!(await this.validatePeerEndpoint(data))) {
          logger.debug(`invalid peer announcement from ${data.nodeId}`);
          return;
        }
        if (!this.isRunning || generation !== this.runGeneration) return;
        if (!this.knownPeers.has(data.nodeId) && this.knownPeers.size >= this.config.maxKnownPeers!) return;
        
        const peer: PeerEndpoint = {
          nodeId: data.nodeId,
          publicKey: data.publicKey,
          tcp: data.tcp,
          height: data.height,
          tipHash: data.tipHash,
          chainId: data.chainId,
          genesisHash: data.genesisHash,
          version: data.version,
          timestamp: data.timestamp,
          lastSeen: Date.now(),
          capabilities: data.capabilities,
          signature: data.signature
        };
        
        // check if new or updated peer
        const existing = this.knownPeers.get(peer.nodeId);
        if (!existing) {
          logger.info(`discovered new peer: ${peer.nodeId} at ${peer.tcp}`);
          this.knownPeers.set(peer.nodeId, peer);
          this.emit('peer:discovered', peer);
        } else {
          if (peer.timestamp <= existing.timestamp) return;
          const changed = existing.tcp !== peer.tcp || existing.height !== peer.height ||
            existing.tipHash !== peer.tipHash || existing.version !== peer.version ||
            existing.publicKey !== peer.publicKey ||
            JSON.stringify(existing.capabilities) !== JSON.stringify(peer.capabilities);
          this.knownPeers.set(peer.nodeId, peer);
          if (changed) logger.debug(`peer updated: ${peer.nodeId} height=${peer.height}`);
          this.emit('peer:updated', peer);
        }
        
      } catch (error) {
        logger.debug('invalid peer announcement:', error);
      }
    };
    
    await client.pubsub.subscribe(this.discoveryTopic, handler);
    logger.info(`subscribed to ${this.discoveryTopic}`);
  }

  private acceptAnnouncement(sender: string): boolean {
    const now = Date.now();
    let window = this.announcementWindows.get(sender);
    if (!window) {
      if (this.announcementWindows.size >= this.config.maxKnownPeers! * 2) {
        const oldest = this.announcementWindows.keys().next().value;
        if (oldest) this.announcementWindows.delete(oldest);
      }
      window = { startedAt: now, count: 0 };
      this.announcementWindows.set(sender, window);
    } else {
      this.announcementWindows.delete(sender);
      this.announcementWindows.set(sender, window);
    }
    if (now - window.startedAt >= 60000) {
      window.startedAt = now;
      window.count = 0;
    }
    window.count++;
    if (window.count > this.config.maxAnnouncementsPerMinute!) return false;

    if (now - this.totalAnnouncementWindow.startedAt >= 60000) {
      this.totalAnnouncementWindow = { startedAt: now, count: 0 };
    }
    this.totalAnnouncementWindow.count++;
    return this.totalAnnouncementWindow.count <= this.config.maxTotalAnnouncementsPerMinute!;
  }
  
  /**
   * start announcing our tcp endpoint
   */
  private startAnnouncing(initialHeight: number, initialHash: string): void {
    logger.info(`starting announcements for tcp endpoint ${this.config.tcpHost}:${this.config.tcpPort}`);
    
    let currentHeight = initialHeight;
    let currentHash = initialHash;
    
    // allow updating chain info
    this.chainUpdateHandler = ({ height, hash }) => {
      currentHeight = height;
      currentHash = hash;
    };
    this.on('chain:updated', this.chainUpdateHandler);
    
    const announce = async () => {
      if (!this.ipfs || !this.isRunning) {
        logger.warn('cannot announce: ipfs not ready or service not running');
        return;
      }
      
      const unsigned = {
        nodeId: this.config.identity.address,
        publicKey: this.config.identity.publicKey,
        tcp: formatPeerEndpoint(this.config.tcpHost, this.config.tcpPort),
        height: currentHeight,
        tipHash: currentHash,
        chainId: this.config.chainId,
        genesisHash: this.config.genesisHash,
        version: '1.0.0',
        timestamp: Date.now(),
        capabilities: ['full_node', 'mining']
      };
      try {
        const announcement = {
          ...unsigned,
          signature: await sign(this.announcementPayload(unsigned), this.config.identity.privateKey)
        };
        const data = new TextEncoder().encode(JSON.stringify(announcement));
        await this.ipfs.pubsub.publish(this.discoveryTopic, data);
        logger.info(`announced tcp endpoint: ${announcement.tcp} (height=${currentHeight})`);
      } catch (error) {
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
        if (now - peer.lastSeen > timeout) {
          logger.info(`removing stale peer: ${nodeId}`);
          this.knownPeers.delete(nodeId);
          this.emit('peer:removed', peer);
        }
      }
      for (const [sender, window] of this.announcementWindows) {
        if (now - window.startedAt >= 60000) this.announcementWindows.delete(sender);
      }
    }, this.config.cleanupInterval);
  }
  
  /**
   * validate peer endpoint data
   */
  private async validatePeerEndpoint(data: any): Promise<boolean> {
    if (!data.nodeId || typeof data.nodeId !== 'string') return false;
    if (!validateAddress(data.nodeId, this.config.addressPrefix)) return false;
    if (typeof data.publicKey !== 'string' || !publicKeyMatchesAddress(data.publicKey, data.nodeId)) return false;
    if (!data.tcp || typeof data.tcp !== 'string') return false;
    if (!Number.isSafeInteger(data.height) || data.height < 0) return false;
    if (!/^[0-9a-f]{64}$/.test(data.tipHash)) return false;
    if (data.chainId !== this.config.chainId || data.genesisHash !== this.config.genesisHash) return false;
    if (!data.version || typeof data.version !== 'string') return false;
    if (!Number.isSafeInteger(data.timestamp) || Math.abs(Date.now() - data.timestamp) > this.config.peerTimeout!) return false;
    if (!Array.isArray(data.capabilities) || data.capabilities.some((value: unknown) => typeof value !== 'string')) return false;
    if (!/^[0-9a-f]{128}$/.test(data.signature)) return false;
    
    // validate tcp format (host:port)
    if (!parsePeerEndpoint(data.tcp)) return false;
    
    return verify(this.announcementPayload(data), data.signature, data.publicKey);
  }

  private announcementPayload(data: Omit<PeerEndpoint, 'signature' | 'lastSeen'>): Uint8Array {
    return encodeCanonicalFields([
      'bolt:network:discovery:v1',
      PROTOCOL_VERSION.toString(),
      data.chainId.toString(),
      data.genesisHash,
      data.nodeId,
      data.publicKey,
      data.tcp,
      data.height.toString(),
      data.tipHash,
      data.version,
      data.timestamp.toString(),
      ...(data.capabilities || [])
    ]);
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
