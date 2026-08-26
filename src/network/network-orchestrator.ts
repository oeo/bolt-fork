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
import type { PeerEndpoint } from './peer-discovery';

const logger = getLogger(__filename);

export enum NetworkMode {
  TCP = 'tcp',        // tcp-based networking with ipfs discovery
  IPFS = 'ipfs'       // legacy mode (not implemented)
}

export interface NetworkOrchestratorConfig {
  mode: NetworkMode;
  identity: NodeIdentity;
  blockchain: Blockchain;
  mempool: Mempool;
  chainConfig: ChainConfig;
  tcpPort?: number;
  ipfsApi?: string;
  externalHost?: string;
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
  
  private isRunning: boolean = false;
  
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
    
    switch (this.mode) {
      case NetworkMode.IPFS:
        await this.startIPFSMode();
        break;
      case NetworkMode.TCP:
        await this.startTCPMode();
        break;
    }
    
    this.isRunning = true;
    logger.info('network orchestrator started');
  }
  
  /**
   * stop all network services
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    logger.info('stopping network orchestrator');
    this.cleanupTCPEventHandlers();
    
    // stop tcp services
    if (this.syncManager) await this.syncManager.stop();
    if (this.connectionManager) await this.connectionManager.stop();
    if (this.txRelay) this.txRelay.stop();
    if (this.inventoryManager) this.inventoryManager.stop();
    if (this.discoveryService) await this.discoveryService.stop();
    
    this.isRunning = false;
    logger.info('network orchestrator stopped');
  }
  
  /**
   * start ipfs-based networking (legacy)
   */
  private async startIPFSMode(): Promise<void> {
    logger.error('ipfs mode is no longer supported - using tcp mode instead');
    this.mode = NetworkMode.TCP;
    await this.startTCPMode();
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
      ipfsApi: this.config.ipfsApi
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

      const height = await this.config.blockchain.getHeight();
      const latestBlock = await this.config.blockchain.getLatestBlock();
      await this.discoveryService.start(height, latestBlock?.hash || genesisHash);
    } catch (error) {
      this.cleanupTCPEventHandlers();
      this.txRelay.stop();
      await this.syncManager.stop();
      await this.connectionManager.stop();
      this.inventoryManager.stop();
      await this.discoveryService.stop();
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
    if (this.blockAddedHandler) this.config.blockchain.off('block:added', this.blockAddedHandler);
    this.blockAddedHandler = undefined;
    this.peerAnnouncementHandler = undefined;
  }
  
  /**
   * broadcast block to network
   */
  async broadcastBlock(block: Block): Promise<void> {
    if (!this.isRunning) return;
    switch (this.mode) {
      case NetworkMode.IPFS:
        break;
      case NetworkMode.TCP:
        this.inventoryManager?.announceBlock(block.hash);
        break;
    }
  }
  
  /**
   * broadcast transaction to network
   */
  async broadcastTransaction(tx: Transaction): Promise<void> {
    if (!this.isRunning) return;
    
    switch (this.mode) {
      case NetworkMode.IPFS:
        break;
      case NetworkMode.TCP:
        if (this.txRelay) {
          this.txRelay.relayTransaction(tx);
        }
        break;
    }
  }
  
  /**
   * get network statistics
   */
  getNetworkStats(): any {
    const stats: any = {
      mode: this.mode,
      isRunning: this.isRunning
    };
    
    if (this.mode === NetworkMode.IPFS) {
    } else {
      stats.discovery = this.discoveryService?.getStats();
      stats.connections = this.connectionManager?.getStats();
      stats.sync = { isSyncing: this.syncManager?.isSyncing() || false };
      stats.inventory = this.inventoryManager?.getStats();
      stats.txRelay = this.txRelay?.getStats();
    }
    
    return stats;
  }
  
  /**
   * get connected peer count
   */
  getPeerCount(): number {
    if (this.mode === NetworkMode.IPFS) {
      return 0;
    } else {
      return this.connectionManager?.getConnectedPeers().length || 0;
    }
  }
}
