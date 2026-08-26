import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Blockchain } from '../core/blockchain';
import type { Block } from '../core/block';
import { BlockClass } from '../core/block';
import type { ConnectionManager } from './connection-manager';
import {
  PROTOCOL_VERSION,
  type Protocol,
  type VerackMessage,
  type VersionMessage
} from './protocol';
import type { PeerDiscoveryService, PeerEndpoint } from './peer-discovery';
import type { ChainConfig } from '../config/chain';
import type { NodeIdentity } from '../utils/identity';
import { publicKeyMatchesAddress, validateAddress } from '../crypto/address';
import { sign, verify } from '../crypto/signature';
import { encodeCanonicalFields } from '../utils/serialization';
import { getSharedSecret } from '@noble/secp256k1';

const logger = getLogger(__filename);

export interface SyncManagerConfig {
  blockchain: Blockchain;
  connectionManager: ConnectionManager;
  protocol: Protocol;
  discoveryService: PeerDiscoveryService;
  chainConfig: ChainConfig;
  genesisHash: string;
  identity: NodeIdentity;
  batchSize?: number;
  syncTimeout?: number;
  maxRetries?: number;
  handshakeClockSkew?: number;
  maxQueuedMessageBytes?: number;
  maxTotalQueuedMessageBytes?: number;
}

interface HandshakeState {
  inbound: boolean;
  localNonce: bigint;
  remoteNonce?: bigint;
  remoteNodeId?: string;
  remotePublicKey?: string;
  versionReceived: boolean;
  versionSent?: Promise<boolean>;
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
  private handshakes = new Map<string, HandshakeState>();
  private messageQueues = new Map<string, Promise<void>>();
  private queuedMessageBytes = new Map<string, number>();
  private totalQueuedMessageBytes = 0;
  private syncStarting = false;
  private acceptingMessages = true;
  private backgroundTasks = new Set<Promise<unknown>>();
  private lifecycleController = new AbortController();
  
  constructor(config: SyncManagerConfig) {
    super();
    this.config = {
      batchSize: 10,
      syncTimeout: 30000,
      maxRetries: 3,
      handshakeClockSkew: 120000,
      maxQueuedMessageBytes: 2 * config.chainConfig.maxBlockSize,
      maxTotalQueuedMessageBytes: 4 * config.chainConfig.maxBlockSize,
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
      this.runTask(this.checkIfSyncNeeded(peer), `sync check failed for ${peer.nodeId}`);
    });
    
    this.config.discoveryService.on('peer:updated', (peer: PeerEndpoint) => {
      this.runTask(this.checkIfSyncNeeded(peer), `sync check failed for ${peer.nodeId}`);
    });
    
    // handle incoming messages
    this.config.connectionManager.on('message:received', (
      peerId: string,
      data: Uint8Array,
      sessionId: string = peerId
    ) => {
      this.enqueueMessage(peerId, sessionId, data);
    });
    
    // handle peer connections
    this.config.connectionManager.on('peer:connected', (sessionId: string, inbound: boolean) => {
      logger.info(`peer connected: ${sessionId}`);
      const state: HandshakeState = {
        inbound,
        localNonce: this.createNonce(),
        versionReceived: false
      };
      this.handshakes.set(sessionId, state);
      state.versionSent = this.trackTask(this.sendVersion(sessionId, state).catch(error => {
        logger.warn(`failed to create version for ${sessionId}`, error);
        return false;
      }));
      void state.versionSent.then(sent => {
        if (!sent) this.config.connectionManager.disconnect(sessionId, 'failed to send version');
      });
    });

    this.config.connectionManager.on('connection:closed', (sessionId: string, peerId?: string) => {
      this.handshakes.delete(sessionId);
    });

    this.on('peer:ready', (peerId: string) => {
      const peer = this.config.discoveryService.getPeer(peerId);
      if (peer) this.runTask(this.checkIfSyncNeeded(peer), `sync check failed for ${peer.nodeId}`);
    });
  }

  private enqueueMessage(peerId: string, sessionId: string, data: Uint8Array): void {
    if (!this.acceptingMessages) return;
    const queuedBytes = (this.queuedMessageBytes.get(sessionId) || 0) + data.length;
    if (queuedBytes > this.config.maxQueuedMessageBytes! ||
        this.totalQueuedMessageBytes + data.length > this.config.maxTotalQueuedMessageBytes!) {
      this.config.connectionManager.disconnect(peerId, 'message queue limit exceeded');
      return;
    }
    this.queuedMessageBytes.set(sessionId, queuedBytes);
    this.totalQueuedMessageBytes += data.length;
    const previous = this.messageQueues.get(sessionId) || Promise.resolve();
    const next = previous
      .then(async () => {
        if (!this.config.connectionManager.getConnection(sessionId)) return;
        const message = this.config.protocol.decodeMessage(data);
        if (!message) {
          this.config.connectionManager.disconnect(peerId, 'invalid protocol message');
          return;
        }
        await this.handleMessage(peerId, message.command, message.payload);
      })
      .catch(error => {
        logger.warn(`message handling failed for ${peerId}`, error);
        this.config.connectionManager.disconnect(peerId, 'message handling failed');
      });
    this.messageQueues.set(sessionId, next);
    void next.finally(() => {
      const remaining = (this.queuedMessageBytes.get(sessionId) || data.length) - data.length;
      if (remaining > 0) this.queuedMessageBytes.set(sessionId, remaining);
      else this.queuedMessageBytes.delete(sessionId);
      this.totalQueuedMessageBytes = Math.max(0, this.totalQueuedMessageBytes - data.length);
      if (this.messageQueues.get(sessionId) === next) this.messageQueues.delete(sessionId);
    });
  }
  
  /**
   * start synchronization process
   */
  async start(): Promise<void> {
    logger.info('starting sync manager');
    this.acceptingMessages = true;
    if (this.lifecycleController.signal.aborted) this.lifecycleController = new AbortController();
    
    // periodic sync check
    this.syncTimer = setInterval(() => {
      this.runTask(this.checkSync(), 'periodic sync check failed');
    }, 10000); // every 10 seconds
    
    // initial sync check
    await this.trackTask(this.checkSync());
  }
  
  /**
   * stop synchronization
   */
  async stop(): Promise<void> {
    logger.info('stopping sync manager');
    this.acceptingMessages = false;
    this.lifecycleController.abort();
    
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    
    if (this.blockTimeout) {
      clearTimeout(this.blockTimeout);
      this.blockTimeout = null;
    }
    
    while (this.messageQueues.size > 0 || this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.messageQueues.values(), ...this.backgroundTasks]);
    }
    this.syncState = SyncState.IDLE;
    this.syncTarget = null;
    this.requestedBlocks.clear();
    this.retryCount = 0;
    this.messageQueues.clear();
    this.queuedMessageBytes.clear();
    this.totalQueuedMessageBytes = 0;
    this.handshakes.clear();
    this.syncStarting = false;
  }
  
  /**
   * check if we need to sync with a peer
   */
  private async checkIfSyncNeeded(peer: PeerEndpoint): Promise<void> {
    if (!this.acceptingMessages) return;
    const ourHeight = await this.config.blockchain.getHeight();
    if (!this.acceptingMessages) return;
    logger.info(`sync check: our height=${ourHeight}, peer ${peer.nodeId} height=${peer.height}`);
    
    if (peer.height > ourHeight) {
      logger.info(`peer has higher chain (${peer.height} vs ${ourHeight})`);
      
      if ((this.syncState === SyncState.IDLE || this.syncState === SyncState.SYNCED) && !this.syncStarting) {
        logger.info(`starting sync with ${peer.nodeId}`);
        this.syncStarting = true;
        try {
          await this.startSyncWithPeer(peer);
        } catch (error) {
          logger.warn(`failed to start sync with ${peer.nodeId}`, error);
          this.syncState = SyncState.IDLE;
          this.syncTarget = null;
        } finally {
          this.syncStarting = false;
        }
      } else {
        logger.debug(`already syncing, state: ${this.syncState}`);
      }
    }
  }
  
  /**
   * start syncing with a specific peer
   */
  private async startSyncWithPeer(peer: PeerEndpoint): Promise<void> {
    if (!this.acceptingMessages) return;
    const currentHeight = await this.config.blockchain.getHeight();
    if (!this.acceptingMessages) return;
    logger.info(`starting sync with ${peer.nodeId} from height ${currentHeight} to ${peer.height}`);

    if (!this.config.connectionManager.isAuthenticated(peer.nodeId)) {
      logger.info(`connecting to sync peer ${peer.nodeId}`);
      const connected = await this.awaitOrStop(this.config.connectionManager.connectToPeer(peer));
      if (connected === undefined || !this.acceptingMessages) return;
      if (!connected) {
        logger.error(`failed to connect to sync target ${peer.nodeId}`);
      }
      return;
    }

    this.syncState = SyncState.SYNCING;
    this.syncTarget = peer;
    this.currentSyncHeight = currentHeight;
    this.targetHeight = peer.height;
    this.retryCount = 0;
    this.requestedBlocks.clear();
    
    // start requesting blocks sequentially
    this.requestNextBatch();
  }
  
  /**
   * request next batch of blocks sequentially
   */
  private requestNextBatch(): void {
    if (!this.acceptingMessages || this.syncState !== SyncState.SYNCING || !this.syncTarget) {
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
    this.runTask(
      this.requestBlocksWithLocator(startHeight, endHeight),
      `failed to request blocks ${startHeight}-${endHeight}`
    );
    
    // set timeout for batch
    this.blockTimeout = setTimeout(() => {
      this.handleBatchTimeout();
    }, this.config.syncTimeout);
  }
  
  /**
   * request blocks using block locator (standard bitcoin protocol)
   */
  private async requestBlocksWithLocator(startHeight: number, endHeight: number): Promise<void> {
    if (!this.acceptingMessages || !this.syncTarget) return;
    
    const locator = await this.buildBlockLocator();
    if (!this.acceptingMessages || !this.syncTarget) return;
    
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
  private async handleMessage(peerId: string, command: string, payload: any): Promise<void> {
    logger.debug(`received ${command} from ${peerId}`);
    
    switch (command) {
      case 'version':
        await this.handleVersion(peerId, payload);
        break;
      case 'verack':
        await this.handleVerack(peerId, payload);
        break;
      case 'block':
        await this.handleBlock(peerId, payload);
        break;
      case 'inv':
        await this.handleInv(peerId, payload);
        break;
      case 'ping':
        this.handlePing(peerId, payload);
        break;
      case 'getdata':
        await this.handleGetdata(peerId, payload);
        break;
      case 'getheaders':
        await this.handleGetHeaders(peerId, payload);
        break;
      case 'getblocks':
        await this.handleGetBlocks(peerId, payload);
        break;
      default:
        logger.debug(`unhandled message type: ${command}`);
    }
  }
  
  /**
   * handle version message
   */
  private async handleVersion(peerId: string, version: VersionMessage): Promise<void> {
    logger.info(`received version from ${peerId}: height=${version.startHeight}`);
    const state = this.handshakes.get(peerId);
    const connection = this.config.connectionManager.getConnection(peerId);
    if (!state || !connection || state.versionReceived) return this.rejectHandshake(peerId, 'unexpected version');
    if (version.version !== PROTOCOL_VERSION) return this.rejectHandshake(peerId, 'unsupported protocol version');
    if (version.chainId !== this.config.chainConfig.chainId || version.genesisHash !== this.config.genesisHash) {
      return this.rejectHandshake(peerId, 'wrong chain identity');
    }
    if (Math.abs(Date.now() - version.timestamp) > this.config.handshakeClockSkew!) {
      return this.rejectHandshake(peerId, 'stale handshake');
    }
    if (version.nodeId === this.config.identity.address ||
        !validateAddress(version.nodeId, this.config.chainConfig.addressPrefix) ||
        !publicKeyMatchesAddress(version.publicKey, version.nodeId)) {
      return this.rejectHandshake(peerId, 'invalid peer identity');
    }
    if (connection.expectedPeerId && connection.expectedPeerId !== version.nodeId) {
      return this.rejectHandshake(peerId, 'discovery identity mismatch');
    }
    const { signature, ...unsigned } = version;
    if (!(await verify(this.config.protocol.versionSigningPayload(unsigned), signature, version.publicKey))) {
      return this.rejectHandshake(peerId, 'invalid version signature');
    }
    if (!(await state.versionSent)) return this.rejectHandshake(peerId, 'local version not sent');

    state.versionReceived = true;
    state.remoteNonce = version.nonce;
    state.remoteNodeId = version.nodeId;
    state.remotePublicKey = version.publicKey;
    const sendKey = this.deriveTransportKey(
      version.publicKey,
      this.config.identity.address,
      version.nodeId,
      state.localNonce,
      version.nonce
    );
    const receiveKey = this.deriveTransportKey(
      version.publicKey,
      version.nodeId,
      this.config.identity.address,
      version.nonce,
      state.localNonce
    );
    if (!this.config.connectionManager.setSessionKeys(peerId, sendKey, receiveKey)) {
      return this.rejectHandshake(peerId, 'failed to initialize session keys');
    }
    
    this.config.connectionManager.updatePeerInfo(peerId, {
      version: version.userAgent,
      height: version.startHeight
    });
    await this.sendVerack(peerId, state);
    this.config.connectionManager.resumeHandshake(peerId);
  }
  
  /**
   * handle verack message
   */
  private async handleVerack(peerId: string, verack: VerackMessage): Promise<void> {
    const state = this.handshakes.get(peerId);
    if (!state?.versionReceived || state.remoteNonce === undefined || !state.remoteNodeId || !state.remotePublicKey) {
      return this.rejectHandshake(peerId, 'verack before version');
    }
    const expectedRole = state.inbound ? 'initiator' : 'responder';
    if (verack.role !== expectedRole ||
        verack.senderNodeId !== state.remoteNodeId ||
        verack.receiverNodeId !== this.config.identity.address ||
        verack.senderNonce !== state.remoteNonce ||
        verack.receiverNonce !== state.localNonce) {
      return this.rejectHandshake(peerId, 'invalid verack transcript');
    }
    const { signature, ...unsigned } = verack;
    if (!(await verify(this.config.protocol.verackSigningPayload(unsigned), signature, state.remotePublicKey))) {
      return this.rejectHandshake(peerId, 'invalid verack signature');
    }
    if (!this.config.connectionManager.bindPeerIdentity(peerId, state.remoteNodeId)) {
      return this.rejectHandshake(peerId, 'duplicate peer identity');
    }

    this.handshakes.delete(peerId);
    logger.info(`authenticated peer ${state.remoteNodeId}`);
    this.emit('peer:ready', state.remoteNodeId);
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
  private async sendVersion(peerId: string, state: HandshakeState): Promise<boolean> {
    const unsigned: Omit<VersionMessage, 'signature'> = {
      version: PROTOCOL_VERSION,
      services: 1n, // full node
      timestamp: Date.now(),
      nonce: state.localNonce,
      userAgent: 'bolt/1.0.0',
      startHeight: await this.config.blockchain.getHeight(),
      chainId: this.config.chainConfig.chainId,
      genesisHash: this.config.genesisHash,
      nodeId: this.config.identity.address,
      publicKey: this.config.identity.publicKey
    };
    const version = {
      ...unsigned,
      signature: await sign(this.config.protocol.versionSigningPayload(unsigned), this.config.identity.privateKey)
    };
    const message = this.config.protocol.encodeMessage('version', version);
    return this.config.connectionManager.sendMessage(peerId, message);
  }

  private async sendVerack(peerId: string, state: HandshakeState): Promise<void> {
    const unsigned: Omit<VerackMessage, 'signature'> = {
      role: state.inbound ? 'responder' : 'initiator',
      senderNodeId: this.config.identity.address,
      receiverNodeId: state.remoteNodeId!,
      senderNonce: state.localNonce,
      receiverNonce: state.remoteNonce!
    };
    const verack = {
      ...unsigned,
      signature: await sign(this.config.protocol.verackSigningPayload(unsigned), this.config.identity.privateKey)
    };
    if (!this.config.connectionManager.sendMessage(peerId, this.config.protocol.encodeMessage('verack', verack))) {
      this.config.connectionManager.disconnect(peerId, 'failed to send verack');
    }
  }

  private deriveTransportKey(
    remotePublicKey: string,
    senderNodeId: string,
    receiverNodeId: string,
    senderNonce: bigint,
    receiverNonce: bigint
  ): Uint8Array {
    const sharedSecret = getSharedSecret(this.config.identity.privateKey, remotePublicKey, true);
    const material = encodeCanonicalFields([
      'bolt:network:transport:v1',
      PROTOCOL_VERSION.toString(),
      this.config.chainConfig.chainId.toString(),
      this.config.genesisHash,
      senderNodeId,
      receiverNodeId,
      senderNonce.toString(),
      receiverNonce.toString(),
      sharedSecret
    ]);
    return new Uint8Array(new Bun.CryptoHasher('sha256').update(material).digest());
  }

  private createNonce(): bigint {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  }

  private rejectHandshake(peerId: string, reason: string): void {
    this.handshakes.delete(peerId);
    this.config.connectionManager.disconnect(peerId, reason);
  }
  
  /**
   * periodic sync check
   */
  private async checkSync(): Promise<void> {
    if (!this.acceptingMessages || this.syncState !== SyncState.IDLE) {
      return; // already syncing
    }
    
    // find best peer
    const bestPeer = this.config.discoveryService.getBestPeer();
    if (bestPeer) {
      await this.checkIfSyncNeeded(bestPeer);
    }
  }

  private trackTask<T>(task: Promise<T>): Promise<T> {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task)
    );
    return task;
  }

  private runTask(task: Promise<unknown>, errorMessage: string): void {
    void this.trackTask(task).catch(error => logger.warn(errorMessage, error));
  }

  private awaitOrStop<T>(task: Promise<T>): Promise<T | undefined> {
    const signal = this.lifecycleController.signal;
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const stopped = () => resolve(undefined);
      signal.addEventListener('abort', stopped, { once: true });
      void task.then(
        value => {
          signal.removeEventListener('abort', stopped);
          resolve(value);
        },
        error => {
          signal.removeEventListener('abort', stopped);
          reject(error);
        }
      );
    });
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
