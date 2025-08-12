import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import { PeerDiscoveryService } from './peer-discovery';
import { ConnectionManager } from './connection-manager';
import { Protocol } from './protocol';
import { SyncManager } from './sync-manager';
import { BlockDownloader } from './block-downloader';
import { InventoryManager } from './inventory-manager';
import { OrphanPool } from './orphan-pool';
import { TransactionRelay } from './transaction-relay';
import { IPFSService } from './ipfs';
import { PeerManager } from './peer-manager';
import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';
import type { ChainConfig } from '../config/chain';
import type { Block } from '../core/block';
import type { Transaction } from '../core/transaction';

const logger = getLogger(__filename);

export enum NetworkMode {
  IPFS = 'ipfs',      // legacy ipfs-based networking (deprecated)
  TCP = 'tcp'         // new tcp-based networking with ipfs discovery
}

export interface NetworkOrchestratorConfig {
  mode: NetworkMode;
  nodeId: string;
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
  
  // ipfs mode services
  private ipfsService?: IPFSService;
  private peerManager?: PeerManager;
  
  // tcp mode services
  private discoveryService?: PeerDiscoveryService;
  private connectionManager?: ConnectionManager;
  private protocol?: Protocol;
  private syncManager?: SyncManager;
  private blockDownloader?: BlockDownloader;
  private inventoryManager?: InventoryManager;
  private orphanPool?: OrphanPool;
  private txRelay?: TransactionRelay;
  
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
    
    // stop ipfs services
    if (this.ipfsService) {
      await this.ipfsService.stop();
    }
    
    // stop tcp services
    if (this.syncManager) await this.syncManager.stop();
    if (this.txRelay) this.txRelay.stop();
    if (this.blockDownloader) this.blockDownloader.clearQueue();
    if (this.inventoryManager) this.inventoryManager.stop();
    if (this.orphanPool) this.orphanPool.stop();
    if (this.connectionManager) await this.connectionManager.stop();
    if (this.discoveryService) await this.discoveryService.stop();
    
    this.isRunning = false;
    logger.info('network orchestrator stopped');
  }
  
  /**
   * start ipfs-based networking (legacy)
   */
  private async startIPFSMode(): Promise<void> {
    logger.info('starting ipfs mode networking');
    
    // create ipfs service
    this.ipfsService = new IPFSService({
      apiUrl: this.config.ipfsApi,
      nodeId: this.config.nodeId,
      chainConfig: this.config.chainConfig
    });
    
    // create peer manager
    const httpUrl = `http://${this.config.externalHost || 'localhost'}:${this.config.tcpPort || 7333}`;
    this.peerManager = new PeerManager({
      ownNodeId: this.config.nodeId,
      ownHttpUrl: httpUrl
    });
    
    // setup ipfs event handlers
    this.ipfsService.on('peer', (data: any) => {
      if (data.httpUrl && data.nodeId !== this.config.nodeId) {
        this.peerManager!.addPeer({
          nodeId: data.nodeId,
          httpUrl: data.httpUrl,
          lastSeen: Date.now()
        });
      }
    });
    
    // forward events
    this.ipfsService.on('block', (block: Block) => {
      this.emit('block:received', block);
    });
    
    this.ipfsService.on('transaction', (tx: Transaction) => {
      this.emit('transaction:received', tx);
    });
    
    // start ipfs service
    await this.ipfsService.start();
    
    logger.info('ipfs mode networking started');
  }
  
  /**
   * start tcp-based networking with ipfs discovery
   * ipfs is ONLY used for peer discovery - all data exchange is over tcp
   */
  private async startTCPMode(): Promise<void> {
    logger.info('starting tcp mode networking with ipfs discovery');
    
    const tcpPort = this.config.tcpPort || 8333;
    const tcpHost = this.config.externalHost || 'localhost';
    
    // create protocol handler
    this.protocol = new Protocol();
    
    // create discovery service - uses ipfs ONLY for peer discovery
    this.discoveryService = new PeerDiscoveryService({
      nodeId: this.config.nodeId,
      tcpHost: tcpHost,
      tcpPort: tcpPort,
      ipfsApi: this.config.ipfsApi
    });
    
    // create connection manager
    this.connectionManager = new ConnectionManager({
      nodeId: this.config.nodeId,
      tcpPort: tcpPort
    });
    
    // create inventory manager
    this.inventoryManager = new InventoryManager({
      connectionManager: this.connectionManager,
      protocol: this.protocol,
      blockchain: this.config.blockchain,
      mempool: this.config.mempool
    });
    
    // create orphan pool
    this.orphanPool = new OrphanPool({
      blockchain: this.config.blockchain
    });
    
    // create block downloader
    this.blockDownloader = new BlockDownloader({
      connectionManager: this.connectionManager,
      protocol: this.protocol,
      inventoryManager: this.inventoryManager
    });
    
    // create sync manager
    this.syncManager = new SyncManager({
      blockchain: this.config.blockchain,
      connectionManager: this.connectionManager,
      protocol: this.protocol,
      discoveryService: this.discoveryService
    });
    
    // create transaction relay
    this.txRelay = new TransactionRelay({
      mempool: this.config.mempool,
      connectionManager: this.connectionManager,
      inventoryManager: this.inventoryManager,
      protocol: this.protocol
    });
    
    // setup event handlers
    this.setupTCPEventHandlers();
    
    // start services
    await this.connectionManager.start();
    
    const height = await this.config.blockchain.getHeight();
    const tipHash = this.config.blockchain.getLatestBlock()?.hash || 'genesis';
    await this.discoveryService.start(height, tipHash);
    
    this.inventoryManager.start();
    this.orphanPool.start();
    await this.syncManager.start();
    this.txRelay.start();
    
    logger.info('tcp mode networking started (ipfs discovery + tcp data exchange)');
  }
  
  /**
   * setup tcp event handlers
   */
  private setupTCPEventHandlers(): void {
    // handle discovered peers
    this.discoveryService!.on('peer:discovered', async (peer) => {
      logger.info(`discovered peer ${peer.nodeId} at ${peer.tcp}`);
      await this.connectionManager!.connectToPeer(peer);
    });
    
    // handle blocks from sync
    this.syncManager!.on('block:received', (block: Block) => {
      this.emit('block:received', block);
    });
    
    // handle orphaned blocks
    this.syncManager!.on('block:orphaned', async (block: Block) => {
      this.orphanPool!.addOrphan(block, 'sync');
    });
    
    // handle parent requests from orphan pool
    this.orphanPool!.on('parent:needed', (parentHash: string, peerId: string) => {
      const items = [{ type: 2, hash: parentHash }];
      const message = this.protocol!.encodeMessage('getdata', items);
      this.connectionManager!.sendMessage(peerId, message);
    });
    
    // handle new blocks added to blockchain
    this.config.blockchain.on('block:added', (block: Block) => {
      // announce to network
      this.inventoryManager!.announceBlock(block.hash);
      
      // check for orphans that can connect
      this.orphanPool!.processOrphansForParent(block.hash);
      
      // update discovery with new height
      this.discoveryService!.updateChainInfo(
        block.index,
        block.hash
      );
    });
    
    // handle new transactions
    this.config.mempool.on('transaction:added', (tx: Transaction) => {
      this.txRelay!.relayTransaction(tx);
    });
    
    // handle incoming transactions from network
    this.txRelay!.on('transaction:received', (tx: Transaction) => {
      this.emit('transaction:received', tx);
    });
    
    // handle block downloads
    this.blockDownloader!.on('block:received', (blockHash: string) => {
      logger.debug(`block ${blockHash.substring(0, 8)}... downloaded`);
    });
    
    // track sync progress
    this.syncManager!.on('sync:complete', () => {
      logger.info('blockchain sync complete');
      this.emit('sync:complete');
    });
  }
  
  /**
   * broadcast block to network
   */
  async broadcastBlock(block: Block): Promise<void> {
    console.log(`[ORCHESTRATOR] broadcastBlock called for block ${block.index} hash=${block.hash.substring(0, 8)}`);
    if (!this.isRunning) {
      console.log(`[ORCHESTRATOR] Not running, skipping broadcast`);
      return;
    }
    
    console.log(`[ORCHESTRATOR] Mode is ${this.mode}`);
    switch (this.mode) {
      case NetworkMode.IPFS:
        console.log(`[ORCHESTRATOR] Using IPFS mode`);
        if (this.peerManager) {
          await this.peerManager.broadcastBlock(block);
        }
        break;
      case NetworkMode.TCP:
        console.log(`[ORCHESTRATOR] Using TCP mode`);
        if (this.inventoryManager) {
          console.log(`[ORCHESTRATOR] Calling inventoryManager.announceBlock`);
          this.inventoryManager.announceBlock(block.hash);
        } else {
          console.log(`[ORCHESTRATOR] No inventoryManager available!`);
        }
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
        if (this.peerManager) {
          await this.peerManager.broadcastTransaction(tx);
        }
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
      stats.ipfs = this.ipfsService?.getStats();
      stats.peers = this.peerManager?.getStats();
    } else {
      stats.discovery = this.discoveryService?.getStats();
      stats.connections = this.connectionManager?.getStats();
      stats.sync = this.syncManager?.getSyncStatus();
      stats.inventory = this.inventoryManager?.getStats();
      stats.orphans = this.orphanPool?.getStats();
      stats.txRelay = this.txRelay?.getStats();
    }
    
    return stats;
  }
  
  /**
   * get connected peer count
   */
  getPeerCount(): number {
    if (this.mode === NetworkMode.IPFS) {
      return this.peerManager?.getActivePeers().length || 0;
    } else {
      return this.connectionManager?.getConnectedPeers().length || 0;
    }
  }
}