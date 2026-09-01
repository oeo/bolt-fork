import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import { PeerDiscoveryService } from './peer-discovery';
import { ConnectionManager } from './connection-manager';
import { Protocol } from './protocol';
import { SyncManager } from './sync-manager';
import { InventoryManager } from './inventory-manager';
import { TransactionRelay } from './transaction-relay';
import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';
import type { ChainConfig } from '../config/chain';
import type { Block } from '../core/block';
import type { Transaction } from '../core/transaction';
import type { NodeIdentity } from '../utils/identity';
import { parsePeerEndpoint, type PeerEndpoint } from './peer-discovery';
import { validateAddress } from '../crypto/address';

const logger = getLogger(__filename);

export enum NetworkMode {
  TCP = 'tcp'
}

export interface NetworkOrchestratorConfig {
  mode: NetworkMode;
  identity: NodeIdentity;
  blockchain: Blockchain;
  mempool: Mempool;
  chainConfig: ChainConfig;
  tcpPort?: number;
  ipfsApi?: string;
  ipfsBootstrap?: boolean;
  externalHost?: string;
  staticPeers?: string[];
  advertise?: boolean;
}

export function parseStaticPeer(value: string, addressPrefix: number): Pick<PeerEndpoint, 'nodeId' | 'tcp'> {
  const separator = value.indexOf('@');
  const nodeId = value.slice(0, separator);
  const tcp = value.slice(separator + 1);
  if (separator < 1 || !validateAddress(nodeId, addressPrefix) || !parsePeerEndpoint(tcp)) {
    throw new Error(`invalid static peer: ${value}`);
  }
  return { nodeId, tcp };
}

/**
 * orchestrates network services based on selected mode
 */
export class NetworkOrchestrator extends EventEmitter {
  private config: NetworkOrchestratorConfig;
  private mode: NetworkMode;
  
  // tcp mode services
  private discoveryService?: PeerDiscoveryService;
  private connectionManager?: ConnectionManager;
  private protocol?: Protocol;
  private syncManager?: SyncManager;
  private inventoryManager?: InventoryManager;
  private txRelay?: TransactionRelay;
  private blockAddedHandler?: (block: Block) => void;
  private peerAnnouncementHandler?: (peer: PeerEndpoint) => void;
  private peerAuthenticatedHandler?: (peerId: string, sessionId: string) => void;
  
  private isRunning: boolean = false;
  private staticPeers: Pick<PeerEndpoint, 'nodeId' | 'tcp'>[] = [];
  private staticPeerTimer?: ReturnType<typeof setInterval>;
  
  constructor(config: NetworkOrchestratorConfig) {
    super();
    this.config = config;
    this.mode = config.mode;
    
    logger.info(`network orchestrator initialized in ${this.mode} mode`);
  }
  
  /**
   * start network services based on mode
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('network orchestrator already running');
      return;
    }
    
    logger.info(`starting network services in ${this.mode} mode`);
    
    try {
      await this.startTCPMode();
      this.isRunning = true;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'network startup and cleanup failed');
      }
      throw error;
    }
    logger.info('network orchestrator started');
  }
  
  /**
   * stop all network services
   */
  async stop(): Promise<void> {
    logger.info('stopping network orchestrator');
    const errors: unknown[] = [];
    if (this.staticPeerTimer) clearInterval(this.staticPeerTimer);
    this.staticPeerTimer = undefined;
    this.cleanupTCPEventHandlers();
    
    if (this.discoveryService) try { await this.discoveryService.stop(); } catch (error) { errors.push(error); }
    if (this.connectionManager) try { await this.connectionManager.stop(); } catch (error) { errors.push(error); }
    if (this.syncManager) try { await this.syncManager.stop(); } catch (error) { errors.push(error); }
    if (this.txRelay) try { this.txRelay.stop(); } catch (error) { errors.push(error); }
    if (this.inventoryManager) try { this.inventoryManager.stop(); } catch (error) { errors.push(error); }
    
    this.isRunning = false;
    logger.info('network orchestrator stopped');
    if (errors.length > 0) throw new AggregateError(errors, 'network shutdown failed');
  }
  
  /**
   * start tcp-based networking with ipfs discovery
   * ipfs is ONLY used for peer discovery - all data exchange is over tcp
   */
  private async startTCPMode(): Promise<void> {
    logger.info('starting tcp mode networking with ipfs discovery');
    
    const tcpPort = this.config.tcpPort || 8333;
    const tcpHost = this.config.externalHost || 'localhost';
    const genesis = await this.config.blockchain.getBlock(0);
    if (!genesis) throw new Error('cannot start networking without genesis block');
    const genesisHash = genesis.hash;
    
    // create protocol handler
    this.protocol = new Protocol({
      chainId: this.config.chainConfig.chainId,
      genesisHash,
      maxPayloadSize: this.config.chainConfig.maxBlockSize
    });
    
    // create discovery service - uses ipfs ONLY for peer discovery
    this.discoveryService = new PeerDiscoveryService({
      identity: this.config.identity,
      chainId: this.config.chainConfig.chainId,
      genesisHash,
      addressPrefix: this.config.chainConfig.addressPrefix,
      tcpHost: tcpHost,
      tcpPort: tcpPort,
      ipfsApi: this.config.ipfsApi,
      bootstrap: this.config.ipfsBootstrap ?? true,
      advertise: this.config.advertise ?? true
    });
    
    // create connection manager
    this.connectionManager = new ConnectionManager({
      nodeId: this.config.identity.address,
      tcpPort: tcpPort,
      protocol: this.protocol,
      maxMessageSize: this.config.chainConfig.maxBlockSize,
      allowPrivatePeers: this.config.chainConfig.name === 'devnet'
    });
    
    // create inventory manager
    this.inventoryManager = new InventoryManager({
      connectionManager: this.connectionManager,
      protocol: this.protocol,
      blockchain: this.config.blockchain,
      mempool: this.config.mempool
    });
    
    // create transaction relay
    this.txRelay = new TransactionRelay({
      mempool: this.config.mempool,
      connectionManager: this.connectionManager,
      inventoryManager: this.inventoryManager,
      protocol: this.protocol
    });

    // create sync manager
    this.syncManager = new SyncManager({
      blockchain: this.config.blockchain,
      connectionManager: this.connectionManager,
      protocol: this.protocol,
      discoveryService: this.discoveryService,
      chainConfig: this.config.chainConfig,
      genesisHash,
      identity: this.config.identity,
      inventoryManager: this.inventoryManager,
      transactionRelay: this.txRelay
    });
    
    // setup event handlers
    this.setupTCPEventHandlers();
    
    try {
      this.inventoryManager.start();
      this.txRelay.start();
      await this.syncManager.start();
      await this.connectionManager.start();

      this.staticPeers = (this.config.staticPeers ?? []).map(value =>
        parseStaticPeer(value, this.config.chainConfig.addressPrefix)
      );
      this.connectStaticPeers();
      this.staticPeerTimer = setInterval(() => this.connectStaticPeers(), 10_000);

      const height = await this.config.blockchain.getHeight();
      const latestBlock = await this.config.blockchain.getLatestBlock();
      await this.discoveryService.start(height, latestBlock?.hash || genesisHash);
    } catch (error) {
      this.cleanupTCPEventHandlers();
      try {
        await this.discoveryService.stop();
        await this.connectionManager.stop();
        await this.syncManager.stop();
        this.txRelay.stop();
        this.inventoryManager.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'tcp startup and cleanup failed');
      }
      throw error;
    }
    
    logger.info('tcp mode networking started (ipfs discovery + tcp data exchange)');
  }
  
  /**
   * setup tcp event handlers
   */
  private setupTCPEventHandlers(): void {
    // handle discovered peers
    this.peerAnnouncementHandler = (peer: PeerEndpoint) => {
      logger.info(`discovered peer ${peer.nodeId} at ${peer.tcp}`);
      void this.connectionManager!.connectToPeer(peer);
    };
    this.discoveryService!.on('peer:discovered', this.peerAnnouncementHandler);
    this.discoveryService!.on('peer:updated', this.peerAnnouncementHandler);
    this.peerAuthenticatedHandler = (peerId: string, sessionId: string) => {
      const connection = this.connectionManager!.getConnection(sessionId);
      this.discoveryService!.promotePeer(peerId, connection?.dialEndpoint);
    };
    this.connectionManager!.on('peer:authenticated', this.peerAuthenticatedHandler);
    
    // handle blocks from sync
    this.syncManager!.on('block:received', (block: Block) => {
      this.emit('block:received', block);
    });
    
    // handle new blocks added to blockchain
    this.blockAddedHandler = (block: Block) => {
      // announce to network
      this.inventoryManager!.announceBlock(block.hash);
      
      // update discovery with new height
      this.discoveryService!.updateChainInfo(
        block.index,
        block.hash
      );
    };
    this.config.blockchain.on('block:added', this.blockAddedHandler);
    
    // handle incoming transactions from network
    this.txRelay!.on('transaction:received', (tx: Transaction) => {
      this.emit('transaction:received', tx);
    });
    
    // track sync progress
    this.syncManager!.on('sync:complete', () => {
      logger.info('blockchain sync complete');
      this.emit('sync:complete');
    });
  }

  private cleanupTCPEventHandlers(): void {
    if (this.peerAnnouncementHandler && this.discoveryService) {
      this.discoveryService.off('peer:discovered', this.peerAnnouncementHandler);
      this.discoveryService.off('peer:updated', this.peerAnnouncementHandler);
    }
    if (this.peerAuthenticatedHandler && this.connectionManager) {
      this.connectionManager.off('peer:authenticated', this.peerAuthenticatedHandler);
    }
    if (this.blockAddedHandler) this.config.blockchain.off('block:added', this.blockAddedHandler);
    this.blockAddedHandler = undefined;
    this.peerAnnouncementHandler = undefined;
    this.peerAuthenticatedHandler = undefined;
  }

  private connectStaticPeers(): void {
    for (const peer of this.staticPeers) {
      if (!this.connectionManager?.isAuthenticated(peer.nodeId)) {
        void this.connectionManager?.connectToPeer(peer as PeerEndpoint);
      }
    }
  }
  
  /**
   * broadcast block to network
   */
  async broadcastBlock(block: Block): Promise<void> {
    if (!this.isRunning) return;
    this.inventoryManager?.announceBlock(block.hash);
  }
  
  /**
   * broadcast transaction to network
   */
  async broadcastTransaction(tx: Transaction): Promise<void> {
    if (!this.isRunning) return;
    
    this.txRelay?.relayTransaction(tx);
  }
  
  /**
   * get network statistics
   */
  getNetworkStats(): any {
    const stats: any = {
      mode: this.mode,
      isRunning: this.isRunning
    };
    
    stats.discovery = this.discoveryService?.getStats();
    stats.connections = this.connectionManager?.getStats();
    stats.sync = { isSyncing: this.syncManager?.isSyncing() || false };
    stats.inventory = this.inventoryManager?.getStats();
    stats.txRelay = this.txRelay?.getStats();
    
    return stats;
  }
  
  /**
   * get connected peer count
   */
  getPeerCount(): number {
    return this.connectionManager?.getConnectedPeers().length || 0;
  }
}
