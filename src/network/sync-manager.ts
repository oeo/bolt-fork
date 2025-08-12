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
  private missingBlocksByHeight: Map<number, string> = new Map();
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
      console.log(`[SYNC] message:received event fired for peer ${peerId}, data size: ${data.length}`);
      const message = this.config.protocol.decodeMessage(data);
      if (message) {
        console.log(`[SYNC] Decoded message: ${message.command}`);
        this.handleMessage(peerId, message.command, message.payload);
      } else {
        console.log(`[SYNC] Failed to decode message from ${peerId}`);
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
    this.missingBlocksByHeight.clear();
  }
  
  /**
   * check if we need to sync with a peer
   */
  private async checkIfSyncNeeded(peer: PeerEndpoint): Promise<void> {
    const ourHeight = await this.config.blockchain.getHeight();
    logger.info(`[SYNC CHECK] our height: ${ourHeight}, peer ${peer.nodeId} height: ${peer.height}`);
    
    if (peer.height > ourHeight) {
      logger.info(`peer ${peer.nodeId} has higher chain (${peer.height} vs ${ourHeight})`);
      
      // if not syncing or this peer is better than current target
      if (this.syncState === SyncState.IDLE || 
          (this.syncTarget && peer.height > this.syncTarget.height)) {
        logger.info(`[SYNC START] initiating sync with ${peer.nodeId}`);
        this.startSyncWithPeer(peer);
      } else {
        logger.info(`[SYNC SKIP] already syncing, state: ${this.syncState}`);
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
    const isConnected = this.config.connectionManager.isConnected(peer.nodeId);
    logger.info(`[SYNC] peer ${peer.nodeId} connected: ${isConnected}`);
    
    if (!isConnected) {
      logger.info(`[SYNC] connecting to peer ${peer.nodeId}`);
      const connected = await this.config.connectionManager.connectToPeer(peer);
      if (!connected) {
        logger.error(`failed to connect to sync target ${peer.nodeId}`);
        this.syncState = SyncState.IDLE;
        this.syncTarget = null;
        return;
      }
      logger.info(`[SYNC] connected to peer ${peer.nodeId}`);
    }
    
    // request headers
    logger.info(`[SYNC] about to request headers from ${peer.nodeId}`);
    await this.requestHeaders(peer.nodeId);
    logger.info(`[SYNC] headers request sent to ${peer.nodeId}`);
  }
  
  /**
   * request headers from peer
   */
  private async requestHeaders(peerId: string): Promise<void> {
    const locator = await this.buildBlockLocator();
    const stopHash = '0'.repeat(64); // request all headers
    
    logger.info(`[HEADERS REQUEST] requesting headers from ${peerId}, locator size: ${locator.length}`);
    logger.info(`[HEADERS REQUEST] locator: ${JSON.stringify(locator.slice(0, 3))}...`);
    
    const message = this.config.protocol.encodeMessage('getheaders', {
      locator: locator,
      stopHash: stopHash
    });
    
    const sent = this.config.connectionManager.sendMessage(peerId, message);
    logger.info(`[HEADERS REQUEST] message sent to ${peerId}: ${sent}`);
  }
  
  /**
   * build block locator for finding common ancestor
   */
  private async buildBlockLocator(): Promise<string[]> {
    const locator: string[] = [];
    let height = await this.config.blockchain.getHeight();
    let step = 1;
    
    // exponential backoff through chain
    while (height > 0) {
      const block = await this.config.blockchain.getBlock(height);
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
    const genesis = await this.config.blockchain.getBlock(0);
    if (genesis && !locator.includes(genesis.hash)) {
      locator.push(genesis.hash);
    }
    
    return locator;
  }
  
  /**
   * handle incoming message from peer
   */
  private handleMessage(peerId: string, command: string, payload: any): void {
    console.log(`[SYNC] Received ${command} from ${peerId}`)
    logger.info(`[MESSAGE] received ${command} from ${peerId}`);
    
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
      case 'getdata':
        this.handleGetdata(peerId, payload);
        break;
      case 'getheaders':
        this.handleGetHeaders(peerId, payload);
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
    
    if (headers.length === 0) {
      return;
    }
    
    // validate first header connects to something we know
    const firstHeader = headers[0];
    const parentBlock = await this.config.blockchain.getBlockByHash(firstHeader.previousHash);
    if (!parentBlock && firstHeader.height > 0) {
      logger.error(`first header at height ${firstHeader.height} doesn't connect to known chain`);
      // we might be missing earlier blocks, request from genesis
      this.missingBlocks.clear();
      this.missingBlocksByHeight.clear();
      this.headerChain.clear();
      await this.requestHeaders(peerId);
      return;
    }
    
    // validate header chain
    let prevHash = firstHeader.previousHash;
    for (const header of headers) {
      // validate header connects to previous
      if (header.previousHash !== prevHash) {
        logger.error(`received invalid header chain: header at height ${header.height} has previousHash ${header.previousHash} but expected ${prevHash}`);
        this.syncState = SyncState.IDLE;
        return;
      }
      
      // add to header chain
      this.headerChain.set(header.height, header);
      
      // check if we have this block
      const existingBlock = await this.config.blockchain.getBlockByHash(header.hash);
      if (!existingBlock) {
        this.missingBlocks.add(header.hash);
        this.missingBlocksByHeight.set(header.height, header.hash);
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
    logger.info(`[BLOCK RECEIVED] block ${block.index} hash=${block.hash.substring(0, 8)} from ${peerId}`);
    
    // remove from missing blocks
    this.missingBlocks.delete(block.hash);
    this.missingBlocksByHeight.delete(block.index);
    
    // add block to blockchain
    try {
      await this.config.blockchain.addBlock(block);
      const height = await this.config.blockchain.getHeight();
      logger.info(`[CHAIN UPDATED] added block ${block.index} to chain, new height=${height}`);
      
      // check if sync is complete
      if (this.missingBlocksByHeight.size === 0) {
        logger.info('[SYNC COMPLETE] blockchain synchronized');
        this.syncState = SyncState.SYNCED;
        this.emit('sync:complete');
      } else if (this.syncState === SyncState.SYNCING_BLOCKS) {
        // continue downloading next blocks
        await this.downloadMissingBlocks();
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
  private async handleInv(peerId: string, items: any[]): Promise<void> {
    logger.info(`received inv with ${items.length} items from ${peerId}`);
    
    // request items we don't have
    const needed: any[] = [];
    for (const item of items) {
      console.log(`[SYNC] Checking inv item type=${item.type} hash=${item.hash}`);
      // type 2 = block, type 1 = transaction
      if (item.type === 2) {
        const hasBlock = await this.config.blockchain.getBlockByHash(item.hash);
        console.log(`[SYNC] Has block ${item.hash}? ${!!hasBlock}`);
        if (!hasBlock) {
          logger.info(`requesting block ${item.hash} from ${peerId}`);
          needed.push(item);
        }
      }
      // ignore transactions for now
    }
    
    if (needed.length > 0) {
      logger.info(`requesting ${needed.length} blocks via getdata`);
      const getdata = this.config.protocol.encodeMessage('getdata', needed);
      this.config.connectionManager.sendMessage(peerId, getdata);
    }
  }
  
  /**
   * handle getheaders message
   */
  private async handleGetHeaders(peerId: string, payload: any): Promise<void> {
    logger.info(`[GETHEADERS] received request from ${peerId}`);
    
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
        logger.info(`[GETHEADERS] found common ancestor at height ${block.index}`);
        break;
      }
    }
    
    // get headers from startHeight
    const currentHeight = await this.config.blockchain.getHeight();
    logger.info(`[GETHEADERS] sending headers from ${startHeight} to ${currentHeight}`);
    
    for (let height = startHeight; height <= currentHeight && headers.length < maxHeaders; height++) {
      const block = await this.config.blockchain.getBlock(height);
      if (block) {
        headers.push({
          height: block.index,
          hash: block.hash,
          previousHash: block.previousHash,
          timestamp: block.timestamp,
          merkleRoot: block.merkleRoot,
          difficulty: block.difficulty,
          nonce: block.nonce
        });
        
        // stop if we reach stopHash
        if (stopHash && block.hash === stopHash) {
          break;
        }
      }
    }
    
    logger.info(`[GETHEADERS] sending ${headers.length} headers to ${peerId}`);
    
    // send headers response
    const message = this.config.protocol.encodeMessage('headers', headers);
    this.config.connectionManager.sendMessage(peerId, message);
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
      version: 1,
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
   * download missing blocks
   */
  private async downloadMissingBlocks(): Promise<void> {
    if (this.missingBlocksByHeight.size === 0) {
      logger.info('no blocks to download');
      this.syncState = SyncState.SYNCED;
      return;
    }
    
    logger.info(`downloading ${this.missingBlocksByHeight.size} blocks`);
    
    // get sorted heights
    const heights = Array.from(this.missingBlocksByHeight.keys()).sort((a, b) => a - b);
    
    // request blocks in order, starting from lowest height
    const currentHeight = await this.config.blockchain.getHeight();
    const nextHeight = currentHeight + 1;
    
    // find blocks we can request (must be sequential from current height)
    const blocksToRequest: string[] = [];
    for (let h = nextHeight; h < nextHeight + 16 && h <= heights[heights.length - 1]; h++) {
      const hash = this.missingBlocksByHeight.get(h);
      if (hash) {
        blocksToRequest.push(hash);
      } else {
        // missing a block in sequence, stop here
        break;
      }
    }
    
    if (blocksToRequest.length === 0) {
      logger.warn(`cannot download blocks: missing block at height ${nextHeight}`);
      // might need to re-request headers
      return;
    }
    
    logger.info(`requesting blocks ${nextHeight} to ${nextHeight + blocksToRequest.length - 1}`);
    
    const items = blocksToRequest.map(hash => ({ type: 2, hash })); // type 2 = block
    
    // prefer sync target if still connected, otherwise use any peer
    let targetPeer: string | null = null;
    
    if (this.syncTarget && this.config.connectionManager.isConnected(this.syncTarget.nodeId)) {
      targetPeer = this.syncTarget.nodeId;
    } else {
      const peers = this.config.connectionManager.getConnectedPeers();
      if (peers.length > 0) {
        targetPeer = peers[0];
      }
    }
    
    if (targetPeer) {
      const getdata = this.config.protocol.encodeMessage('getdata', items);
      this.config.connectionManager.sendMessage(targetPeer, getdata);
    } else {
      logger.warn('no connected peers to download blocks from');
      // try to reconnect to sync target
      if (this.syncTarget) {
        logger.info(`attempting to reconnect to sync target ${this.syncTarget.nodeId}`);
        await this.config.connectionManager.connectToPeer(this.syncTarget);
      }
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
  async getSyncStatus(): Promise<{
    state: SyncState;
    targetHeight: number | null;
    currentHeight: number;
    headersReceived: number;
    blocksToDownload: number;
  }> {
    return {
      state: this.syncState,
      targetHeight: this.syncTarget?.height || null,
      currentHeight: await this.config.blockchain.getHeight(),
      headersReceived: this.headerChain.size,
      blocksToDownload: this.missingBlocks.size
    };
  }
}