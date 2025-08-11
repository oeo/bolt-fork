import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Blockchain } from '../core/blockchain';
import type { Block } from '../core/block';
import type { ConnectionManager } from './connection-manager';
import type { Protocol } from './protocol';
import type { PeerDiscoveryService, PeerEndpoint } from './peer-discovery';

const logger = getLogger(__filename);

export interface BlockHeader {
  hash: string;
  previousHash: string;
  merkleRoot: string;
  timestamp: number;
  difficulty: number;
  nonce: number;
  height: number;
}

export interface SyncManagerConfig {
  blockchain: Blockchain;
  connectionManager: ConnectionManager;
  protocol: Protocol;
  discoveryService: PeerDiscoveryService;
  maxHeadersPerRequest?: number;
  syncTimeout?: number;
}

export enum SyncState {
  IDLE = 'idle',
  SYNCING_HEADERS = 'syncing_headers',
  SYNCING_BLOCKS = 'syncing_blocks',
  SYNCED = 'synced'
}

/**
 * manages blockchain synchronization using headers-first approach
 */
export class SyncManager extends EventEmitter {
  private config: SyncManagerConfig;
  private syncState: SyncState = SyncState.IDLE;
  private headerChain: Map<number, BlockHeader> = new Map();
  private syncTarget: PeerEndpoint | null = null;
  private missingBlocks: Set<string> = new Set();
  private syncTimer: any;
  
  constructor(config: SyncManagerConfig) {
    super();
    this.config = {
      maxHeadersPerRequest: 2000,
      syncTimeout: 30000,
      ...config
    };
    
    this.setupEventHandlers();
  }
  
  /**
   * setup event handlers for peer and message events
   */
  private setupEventHandlers(): void {
    // handle new peer discoveries
    this.config.discoveryService.on('peer:discovered', (peer: PeerEndpoint) => {
      this.checkIfSyncNeeded(peer);
    });
    
    this.config.discoveryService.on('peer:updated', (peer: PeerEndpoint) => {
      this.checkIfSyncNeeded(peer);
    });
    
    // handle incoming messages
    this.config.connectionManager.on('message:received', (peerId: string, data: Uint8Array) => {
      const message = this.config.protocol.decodeMessage(data);
      if (message) {
        this.handleMessage(peerId, message.command, message.payload);
      }
    });
    
    // handle peer connections
    this.config.connectionManager.on('peer:connected', (peerId: string) => {
      logger.info(`peer connected: ${peerId}`);
      // send version handshake
      this.sendVersion(peerId);
    });
  }
  
  /**
   * start synchronization process
   */
  async start(): Promise<void> {
    logger.info('starting sync manager');
    
    // periodic sync check
    this.syncTimer = setInterval(() => {
      this.checkSync();
    }, 10000); // every 10 seconds
    
    // initial sync check
    await this.checkSync();
  }
  
  /**
   * stop synchronization
   */
  async stop(): Promise<void> {
    logger.info('stopping sync manager');
    
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    
    this.syncState = SyncState.IDLE;
    this.headerChain.clear();
    this.missingBlocks.clear();
  }
  
  /**
   * check if we need to sync with a peer
   */
  private checkIfSyncNeeded(peer: PeerEndpoint): void {
    const ourHeight = this.config.blockchain.getHeight();
    
    if (peer.height > ourHeight) {
      logger.info(`peer ${peer.nodeId} has higher chain (${peer.height} vs ${ourHeight})`);
      
      // if not syncing or this peer is better than current target
      if (this.syncState === SyncState.IDLE || 
          (this.syncTarget && peer.height > this.syncTarget.height)) {
        this.startSyncWithPeer(peer);
      }
    }
  }
  
  /**
   * start syncing with a specific peer
   */
  private async startSyncWithPeer(peer: PeerEndpoint): Promise<void> {
    logger.info(`starting sync with ${peer.nodeId} at height ${peer.height}`);
    
    this.syncTarget = peer;
    this.syncState = SyncState.SYNCING_HEADERS;
    
    // connect to peer if not already connected
    if (!this.config.connectionManager.isConnected(peer.nodeId)) {
      const connected = await this.config.connectionManager.connectToPeer(peer);
      if (!connected) {
        logger.error(`failed to connect to sync target ${peer.nodeId}`);
        this.syncState = SyncState.IDLE;
        this.syncTarget = null;
        return;
      }
    }
    
    // request headers
    this.requestHeaders(peer.nodeId);
  }
  
  /**
   * request headers from peer
   */
  private requestHeaders(peerId: string): void {
    const locator = this.buildBlockLocator();
    const stopHash = '0'.repeat(64); // request all headers
    
    logger.info(`requesting headers from ${peerId}, locator size: ${locator.length}`);
    
    const message = this.config.protocol.encodeMessage('getheaders', {
      locator: locator,
      stopHash: stopHash
    });
    
    this.config.connectionManager.sendMessage(peerId, message);
  }
  
  /**
   * build block locator for finding common ancestor
   */
  private buildBlockLocator(): string[] {
    const locator: string[] = [];
    let height = this.config.blockchain.getHeight();
    let step = 1;
    
    // exponential backoff through chain
    while (height > 0) {
      const block = this.config.blockchain.getBlockByHeight(height);
      if (block) {
        locator.push(block.hash);
      }
      
      height -= step;
      
      // exponentially increase step after first 10 blocks
      if (locator.length > 10) {
        step *= 2;
      }
      
      // limit locator size
      if (locator.length >= 32) {
        break;
      }
    }
    
    // always include genesis
    const genesis = this.config.blockchain.getBlockByHeight(0);
    if (genesis && !locator.includes(genesis.hash)) {
      locator.push(genesis.hash);
    }
    
    return locator;
  }
  
  /**
   * handle incoming message from peer
   */
  private handleMessage(peerId: string, command: string, payload: any): void {
    logger.debug(`received ${command} from ${peerId}`);
    
    switch (command) {
      case 'version':
        this.handleVersion(peerId, payload);
        break;
      case 'verack':
        this.handleVerack(peerId);
        break;
      case 'headers':
        this.handleHeaders(peerId, payload);
        break;
      case 'block':
        this.handleBlock(peerId, payload);
        break;
      case 'inv':
        this.handleInv(peerId, payload);
        break;
      case 'ping':
        this.handlePing(peerId, payload);
        break;
      default:
        logger.debug(`unhandled message type: ${command}`);
    }
  }
  
  /**
   * handle version message
   */
  private handleVersion(peerId: string, version: any): void {
    logger.info(`received version from ${peerId}: height=${version.startHeight}`);
    
    // update peer info
    this.config.connectionManager.updatePeerInfo(peerId, {
      version: version.userAgent,
      height: version.startHeight
    });
    
    // send verack
    const verack = this.config.protocol.encodeMessage('verack', {});
    this.config.connectionManager.sendMessage(peerId, verack);
    
    // check if we should sync with this peer
    const peer = this.config.discoveryService.getPeer(peerId);
    if (peer) {
      this.checkIfSyncNeeded(peer);
    }
  }
  
  /**
   * handle verack message
   */
  private handleVerack(peerId: string): void {
    logger.debug(`received verack from ${peerId}`);
    // connection is now fully established
    this.emit('peer:ready', peerId);
  }
  
  /**
   * handle headers message
   */
  private async handleHeaders(peerId: string, headers: BlockHeader[]): Promise<void> {
    if (headers.length === 0) {
      logger.info('received empty headers, sync complete');
      this.syncState = SyncState.SYNCING_BLOCKS;
      this.downloadMissingBlocks();
      return;
    }
    
    logger.info(`received ${headers.length} headers from ${peerId}`);
    
    // validate header chain
    let prevHash = '';
    for (const header of headers) {
      // validate header connects to previous
      if (prevHash && header.previousHash !== prevHash) {
        logger.error('received invalid header chain');
        this.syncState = SyncState.IDLE;
        return;
      }
      
      // add to header chain
      this.headerChain.set(header.height, header);
      
      // check if we have this block
      const existingBlock = this.config.blockchain.getBlockByHash(header.hash);
      if (!existingBlock) {
        this.missingBlocks.add(header.hash);
      }
      
      prevHash = header.hash;
    }
    
    // request more headers if needed
    const lastHeader = headers[headers.length - 1];
    if (this.syncTarget && lastHeader.height < this.syncTarget.height) {
      this.requestHeaders(peerId);
    } else {
      // headers sync complete, start downloading blocks
      logger.info(`headers sync complete, need ${this.missingBlocks.size} blocks`);
      this.syncState = SyncState.SYNCING_BLOCKS;
      this.downloadMissingBlocks();
    }
  }
  
  /**
   * handle block message
   */
  private async handleBlock(peerId: string, block: Block): Promise<void> {
    logger.debug(`received block ${block.index} from ${peerId}`);
    
    // remove from missing blocks
    this.missingBlocks.delete(block.hash);
    
    // add block to blockchain
    try {
      await this.config.blockchain.addBlock(block);
      logger.info(`added block ${block.index} to chain`);
      
      // check if sync is complete
      if (this.missingBlocks.size === 0) {
        logger.info('block sync complete');
        this.syncState = SyncState.SYNCED;
        this.emit('sync:complete');
      }
    } catch (error) {
      logger.error(`failed to add block ${block.index}:`, error);
      // block might be orphaned, will handle later
      this.emit('block:orphaned', block);
    }
  }
  
  /**
   * handle inventory message
   */
  private handleInv(peerId: string, items: any[]): void {
    logger.debug(`received inv with ${items.length} items from ${peerId}`);
    
    // request items we don't have
    const needed = items.filter(item => {
      if (item.type === 'block') {
        return !this.config.blockchain.getBlockByHash(item.hash);
      }
      return false; // ignore transactions for now
    });
    
    if (needed.length > 0) {
      const getdata = this.config.protocol.encodeMessage('getdata', needed);
      this.config.connectionManager.sendMessage(peerId, getdata);
    }
  }
  
  /**
   * handle ping message
   */
  private handlePing(peerId: string, ping: { nonce: bigint }): void {
    // respond with pong
    const pong = this.config.protocol.encodeMessage('pong', ping);
    this.config.connectionManager.sendMessage(peerId, pong);
  }
  
  /**
   * send version message to peer
   */
  private sendVersion(peerId: string): void {
    const version = {
      version: 1,
      services: 1n, // full node
      timestamp: Date.now(),
      addrRecv: 'peer',
      addrFrom: 'self',
      nonce: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
      userAgent: 'bolt/1.0.0',
      startHeight: this.config.blockchain.getHeight()
    };
    
    const message = this.config.protocol.encodeMessage('version', version);
    this.config.connectionManager.sendMessage(peerId, message);
  }
  
  /**
   * download missing blocks
   */
  private downloadMissingBlocks(): void {
    if (this.missingBlocks.size === 0) {
      logger.info('no blocks to download');
      this.syncState = SyncState.SYNCED;
      return;
    }
    
    logger.info(`downloading ${this.missingBlocks.size} blocks`);
    
    // request blocks from peers
    const blocks = Array.from(this.missingBlocks).slice(0, 16); // request up to 16 at a time
    const items = blocks.map(hash => ({ type: 'block', hash }));
    
    // send to sync target or any connected peer
    const peers = this.config.connectionManager.getConnectedPeers();
    if (peers.length > 0) {
      const getdata = this.config.protocol.encodeMessage('getdata', items);
      this.config.connectionManager.sendMessage(peers[0], getdata);
    }
  }
  
  /**
   * periodic sync check
   */
  private async checkSync(): Promise<void> {
    if (this.syncState !== SyncState.IDLE) {
      return; // already syncing
    }
    
    // find best peer
    const bestPeer = this.config.discoveryService.getBestPeer();
    if (bestPeer) {
      this.checkIfSyncNeeded(bestPeer);
    }
  }
  
  /**
   * get sync status
   */
  getSyncStatus(): {
    state: SyncState;
    targetHeight: number | null;
    currentHeight: number;
    headersReceived: number;
    blocksToDownload: number;
  } {
    return {
      state: this.syncState,
      targetHeight: this.syncTarget?.height || null,
      currentHeight: this.config.blockchain.getHeight(),
      headersReceived: this.headerChain.size,
      blocksToDownload: this.missingBlocks.size
    };
  }
}