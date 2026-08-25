import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Blockchain } from '../core/blockchain';
import type { Block } from '../core/block';
import { BlockClass } from '../core/block';
import type { ConnectionManager } from './connection-manager';
import { PROTOCOL_VERSION, type Protocol } from './protocol';
import type { PeerDiscoveryService, PeerEndpoint } from './peer-discovery';

const logger = getLogger(__filename);

export interface SyncManagerConfig {
  blockchain: Blockchain;
  connectionManager: ConnectionManager;
  protocol: Protocol;
  discoveryService: PeerDiscoveryService;
  batchSize?: number;
  syncTimeout?: number;
  maxRetries?: number;
}

export enum SyncState {
  IDLE = 'idle',
  SYNCING = 'syncing',
  SYNCED = 'synced'
}

/**
 * manages blockchain synchronization using sequential block downloads
 */
export class SyncManager extends EventEmitter {
  private config: SyncManagerConfig;
  private syncState: SyncState = SyncState.IDLE;
  private syncTarget: PeerEndpoint | null = null;
  private currentSyncHeight: number = 0;
  private targetHeight: number = 0;
  private syncTimer: any;
  private retryCount: number = 0;
  private requestedBlocks: Set<number> = new Set();
  private blockTimeout: any;
  
  constructor(config: SyncManagerConfig) {
    super();
    this.config = {
      batchSize: 10,
      syncTimeout: 30000,
      maxRetries: 3,
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
    
    if (this.blockTimeout) {
      clearTimeout(this.blockTimeout);
      this.blockTimeout = null;
    }
    
    this.syncState = SyncState.IDLE;
    this.syncTarget = null;
    this.requestedBlocks.clear();
    this.retryCount = 0;
  }
  
  /**
   * check if we need to sync with a peer
   */
  private async checkIfSyncNeeded(peer: PeerEndpoint): Promise<void> {
    const ourHeight = await this.config.blockchain.getHeight();
    logger.info(`sync check: our height=${ourHeight}, peer ${peer.nodeId} height=${peer.height}`);
    
    if (peer.height > ourHeight) {
      logger.info(`peer has higher chain (${peer.height} vs ${ourHeight})`);
      
      // if not syncing or this peer is better than current target
      if (this.syncState === SyncState.IDLE || 
          (this.syncTarget && peer.height > this.syncTarget.height)) {
        logger.info(`starting sync with ${peer.nodeId}`);
        this.startSyncWithPeer(peer);
      } else {
        logger.debug(`already syncing, state: ${this.syncState}`);
      }
    }
  }
  
  /**
   * start syncing with a specific peer
   */
  private async startSyncWithPeer(peer: PeerEndpoint): Promise<void> {
    logger.info(`starting sync with ${peer.nodeId} from height ${await this.config.blockchain.getHeight()} to ${peer.height}`);
    
    this.syncTarget = peer;
    this.syncState = SyncState.SYNCING;
    this.currentSyncHeight = await this.config.blockchain.getHeight();
    this.targetHeight = peer.height;
    this.retryCount = 0;
    this.requestedBlocks.clear();
    
    // connect to peer if not already connected
    const isConnected = this.config.connectionManager.isConnected(peer.nodeId);
    
    if (!isConnected) {
      logger.info(`connecting to sync peer ${peer.nodeId}`);
      const connected = await this.config.connectionManager.connectToPeer(peer);
      if (!connected) {
        logger.error(`failed to connect to sync target ${peer.nodeId}`);
        this.syncState = SyncState.IDLE;
        this.syncTarget = null;
        return;
      }
    }
    
    // start requesting blocks sequentially
    this.requestNextBatch();
  }
  
  /**
   * request next batch of blocks sequentially
   */
  private requestNextBatch(): void {
    if (this.syncState !== SyncState.SYNCING || !this.syncTarget) {
      return;
    }
    
    const startHeight = this.currentSyncHeight + 1;
    const endHeight = Math.min(startHeight + this.config.batchSize! - 1, this.targetHeight);
    
    if (startHeight > this.targetHeight) {
      // sync complete
      logger.info(`sync complete at height ${this.currentSyncHeight}`);
      this.syncState = SyncState.SYNCED;
      this.emit('sync:complete');
      return;
    }
    
    logger.info(`requesting blocks ${startHeight} to ${endHeight} from ${this.syncTarget.nodeId}`);
    
    // request blocks by height
    const items = [];
    for (let height = startHeight; height <= endHeight; height++) {
      this.requestedBlocks.add(height);
      // we need to request by height, but protocol expects hash
      // for now, request sequential blocks starting from our current tip
      items.push({ type: 3, height }); // type 3 = block by height (custom extension)
    }
    
    // fallback: if protocol doesn't support height-based requests,
    // we'll need to use getblocks with locator
    this.requestBlocksWithLocator(startHeight, endHeight);
    
    // set timeout for batch
    this.blockTimeout = setTimeout(() => {
      this.handleBatchTimeout();
    }, this.config.syncTimeout);
  }
  
  /**
   * request blocks using block locator (standard bitcoin protocol)
   */
  private async requestBlocksWithLocator(startHeight: number, endHeight: number): Promise<void> {
    if (!this.syncTarget) return;
    
    const locator = await this.buildBlockLocator();
    
    const message = this.config.protocol.encodeMessage('getblocks', {
      locator: locator,
      stopHash: '0'.repeat(64)
    });
    
    this.config.connectionManager.sendMessage(this.syncTarget.nodeId, message);
  }
  
  /**
   * build simple block locator starting from our current height
   */
  private async buildBlockLocator(): Promise<string[]> {
    const locator: string[] = [];
    const currentHeight = await this.config.blockchain.getHeight();
    
    // add current tip
    const tipBlock = await this.config.blockchain.getBlock(currentHeight);
    if (tipBlock) {
      locator.push(tipBlock.hash);
    }
    
    // add genesis
    const genesis = await this.config.blockchain.getBlock(0);
    if (genesis && genesis.hash !== tipBlock?.hash) {
      locator.push(genesis.hash);
    }
    
    return locator;
  }
  
  /**
   * handle batch timeout - retry or give up
   */
  private handleBatchTimeout(): void {
    if (this.retryCount < this.config.maxRetries!) {
      this.retryCount++;
      logger.warn(`batch timeout, retrying (${this.retryCount}/${this.config.maxRetries})`);
      this.requestedBlocks.clear();
      this.requestNextBatch();
    } else {
      logger.error(`sync failed after ${this.config.maxRetries} retries, giving up`);
      this.syncState = SyncState.IDLE;
      this.syncTarget = null;
      this.retryCount = 0;
      this.requestedBlocks.clear();
    }
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
      case 'block':
        this.handleBlock(peerId, payload);
        break;
      case 'inv':
        this.handleInv(peerId, payload);
        break;
      case 'ping':
        this.handlePing(peerId, payload);
        break;
      case 'getdata':
        this.handleGetdata(peerId, payload);
        break;
      case 'getheaders':
        this.handleGetHeaders(peerId, payload);
        break;
      case 'getblocks':
        this.handleGetBlocks(peerId, payload);
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

    if (version.version !== PROTOCOL_VERSION) {
      this.config.connectionManager.disconnect(peerId, `unsupported protocol version ${version.version}`);
      return;
    }
    
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
   * handle block message - the core of our simple sync
   */
  private async handleBlock(peerId: string, block: Block): Promise<void> {
    logger.info(`received block ${block.index} (${block.hash.substring(0, 8)}...) from ${peerId}`);
    
    // ignore blocks if we're not syncing or from wrong peer
    if (this.syncState !== SyncState.SYNCING || !this.syncTarget || peerId !== this.syncTarget.nodeId) {
      logger.debug(`ignoring block from ${peerId}, not syncing with this peer`);
      return;
    }
    
    // check if this block is the next one we expect
    const expectedHeight = this.currentSyncHeight + 1;
    if (block.index !== expectedHeight) {
      logger.warn(`received block ${block.index} but expected ${expectedHeight}, ignoring out-of-order block`);
      return;
    }
    
    // try to add block to blockchain
    try {
      const blockClass = BlockClass.fromObject(block);
      const result = await this.config.blockchain.addBlock(blockClass);
      if (result.valid) {
        this.currentSyncHeight = block.index;
        this.requestedBlocks.delete(block.index);
        
        logger.info(`added block ${block.index} to chain, progress: ${block.index}/${this.targetHeight}`);
        
        // clear timeout since we received a valid block
        if (this.blockTimeout) {
          clearTimeout(this.blockTimeout);
          this.blockTimeout = null;
        }
        
        // reset retry count on successful block
        this.retryCount = 0;
        
        // request next batch if we haven't reached target
        if (this.currentSyncHeight < this.targetHeight) {
          this.requestNextBatch();
        } else {
          // sync complete!
          logger.info(`sync complete! reached height ${this.currentSyncHeight}`);
          this.syncState = SyncState.SYNCED;
          this.emit('sync:complete');
        }
      } else {
        logger.error(`failed to add block ${block.index}: ${result.error}`);
        // this might be an orphan - emit event for orphan pool
        this.emit('block:orphaned', block);
      }
    } catch (error) {
      logger.error(`error processing block ${block.index}:`, error);
      // continue with next block request on error
      this.requestNextBatch();
    }
  }
  
  /**
   * handle inventory message
   */
  private async handleInv(peerId: string, items: any[]): Promise<void> {
    logger.debug(`received inv with ${items.length} items from ${peerId}`);
    
    // during sync, only process blocks from our sync target
    if (this.syncState === SyncState.SYNCING && (!this.syncTarget || peerId !== this.syncTarget.nodeId)) {
      return;
    }
    
    // request blocks we don't have
    const needed: any[] = [];
    for (const item of items) {
      // type 2 = block
      if (item.type === 2) {
        const hasBlock = await this.config.blockchain.getBlockByHash(item.hash);
        if (!hasBlock) {
          needed.push(item);
        }
      }
    }
    
    if (needed.length > 0) {
      logger.debug(`requesting ${needed.length} blocks via getdata`);
      const getdata = this.config.protocol.encodeMessage('getdata', needed);
      this.config.connectionManager.sendMessage(peerId, getdata);
    }
  }
  
  /**
   * handle getheaders message
   */
  private async handleGetHeaders(peerId: string, payload: any): Promise<void> {
    logger.debug(`getheaders request from ${peerId}`);
    
    if (!payload || !payload.locator) {
      logger.warn(`invalid getheaders payload from ${peerId}`);
      return;
    }
    
    const { locator, stopHash } = payload;
    const headers: any[] = [];
    const maxHeaders = 2000; // bitcoin protocol limit
    
    // find common ancestor from locator
    let startHeight = 0;
    for (const hash of locator) {
      const block = await this.config.blockchain.getBlockByHash(hash);
      if (block) {
        startHeight = block.index + 1;
        break;
      }
    }
    
    // get headers from startHeight
    const currentHeight = await this.config.blockchain.getHeight();
    
    for (let height = startHeight; height <= currentHeight && headers.length < maxHeaders; height++) {
      const block = await this.config.blockchain.getBlock(height);
      if (block) {
        headers.push({
          height: block.index,
          hash: block.hash,
          previousHash: block.previousHash,
          timestamp: block.timestamp,
          merkleRoot: block.merkleRoot,
          stateRoot: block.stateRoot,
          difficulty: block.difficulty,
          nonce: block.nonce
        });
        
        // stop if we reach stopHash
        if (stopHash && block.hash === stopHash) {
          break;
        }
      }
    }
    
    logger.debug(`sending ${headers.length} headers to ${peerId}`);
    
    // send headers response
    const message = this.config.protocol.encodeMessage('headers', headers);
    this.config.connectionManager.sendMessage(peerId, message);
  }
  
  /**
   * handle getblocks message
   */
  private async handleGetBlocks(peerId: string, payload: any): Promise<void> {
    logger.debug(`getblocks request from ${peerId}`);
    
    if (!payload || !payload.locator) {
      logger.warn(`invalid getblocks payload from ${peerId}`);
      return;
    }
    
    const { locator, stopHash } = payload;
    const inventory: any[] = [];
    const maxBlocks = 500; // reasonable limit
    
    // find common ancestor from locator
    let startHeight = 0;
    for (const hash of locator) {
      const block = await this.config.blockchain.getBlockByHash(hash);
      if (block) {
        startHeight = block.index + 1;
        break;
      }
    }
    
    // get block hashes from startHeight
    const currentHeight = await this.config.blockchain.getHeight();
    
    for (let height = startHeight; height <= currentHeight && inventory.length < maxBlocks; height++) {
      const block = await this.config.blockchain.getBlock(height);
      if (block) {
        inventory.push({
          type: 2, // block type
          hash: block.hash
        });
        
        // stop if we reach stopHash
        if (stopHash && block.hash === stopHash) {
          break;
        }
      }
    }
    
    if (inventory.length > 0) {
      logger.debug(`sending inventory of ${inventory.length} blocks to ${peerId}`);
      const message = this.config.protocol.encodeMessage('inv', inventory);
      this.config.connectionManager.sendMessage(peerId, message);
    }
  }
  
  /**
   * handle getdata message - respond with requested blocks/transactions
   */
  private async handleGetdata(peerId: string, items: any[]): Promise<void> {
    logger.info(`received getdata request for ${items.length} items from ${peerId}`);
    
    for (const item of items) {
      // type 2 = block, type 1 = transaction
      if (item.type === 2) {
        const block = await this.config.blockchain.getBlockByHash(item.hash);
        if (block) {
          logger.info(`sending block ${block.index} (${item.hash}) to ${peerId}`);
          const message = this.config.protocol.encodeMessage('block', block);
          this.config.connectionManager.sendMessage(peerId, message);
        } else {
          logger.warn(`requested block ${item.hash} not found`);
        }
      } else if (item.type === 1) {
        // handle transaction requests if needed
        logger.debug(`transaction request for ${item.hash} - not implemented`);
      }
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
  private async sendVersion(peerId: string): Promise<void> {
    const version = {
      version: PROTOCOL_VERSION,
      services: 1n, // full node
      timestamp: Date.now(),
      addrRecv: 'peer',
      addrFrom: 'self',
      nonce: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
      userAgent: 'bolt/1.0.0',
      startHeight: await this.config.blockchain.getHeight()
    };
    
    const message = this.config.protocol.encodeMessage('version', version);
    this.config.connectionManager.sendMessage(peerId, message);
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
  async getSyncStatus(): Promise<{
    state: SyncState;
    targetHeight: number | null;
    currentHeight: number;
    syncProgress: number;
    syncPeer: string | null;
  }> {
    const currentHeight = await this.config.blockchain.getHeight();
    const progress = this.targetHeight > 0 ? (currentHeight / this.targetHeight) * 100 : 100;
    
    return {
      state: this.syncState,
      targetHeight: this.targetHeight || null,
      currentHeight,
      syncProgress: Math.min(100, Math.max(0, progress)),
      syncPeer: this.syncTarget?.nodeId || null
    };
  }
}
