import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Blockchain } from '../core/blockchain';
import type { Block } from '../core/block';
import { BlockClass } from '../core/block';
import type { ConnectionManager } from './connection-manager';
import {
  InvType,
  MAX_HEADERS,
  PROTOCOL_HEADER_SIZE,
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
import type { InventoryManager } from './inventory-manager';
import type { TransactionRelay } from './transaction-relay';
import type { BlockHeader } from '../core/block';

const logger = getLogger(__filename);

export interface SyncManagerConfig {
  blockchain: Blockchain;
  connectionManager: ConnectionManager;
  protocol: Protocol;
  discoveryService: PeerDiscoveryService;
  chainConfig: ChainConfig;
  genesisHash: string;
  identity: NodeIdentity;
  inventoryManager?: InventoryManager;
  transactionRelay?: TransactionRelay;
  batchSize?: number;
  syncTimeout?: number;
  maxCandidateBlockBytes?: number;
  maxHeaderCandidates?: number;
  maxTransactionRequests?: number;
  maxTransactionRequestsPerPeer?: number;
  handshakeClockSkew?: number;
  maxQueuedMessageBytes?: number;
  maxTotalQueuedMessageBytes?: number;
  messageWorkCapacity?: number;
  messageWorkRefillPerSecond?: number;
  globalMessageWorkCapacity?: number;
  globalMessageWorkRefillPerSecond?: number;
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

interface PendingRequest {
  peerId: string;
  sessionId: string;
  deadline: number;
}

interface HeaderRequest extends PendingRequest {
  headers: BlockHeader[];
}

interface SyncCandidate extends PendingRequest {
  ancestor: Block;
  headers: BlockHeader[];
  cumulativeDifficulty: bigint;
  canonicalTipHash: string;
  blocks: Block[];
  blockBytes: number;
  nextBlock: number;
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
  private syncPeerId: string | null = null;
  private targetHeight: number = 0;
  private syncTimer: any;
  private blockTimeout: any;
  private headerRequests = new Map<string, HeaderRequest>();
  private transactionRequests = new Map<string, PendingRequest>();
  private activeSync: SyncCandidate | null = null;
  private validatingHeaders = false;
  private handshakes = new Map<string, HandshakeState>();
  private messageQueues = new Map<string, Promise<void>>();
  private queuedMessageBytes = new Map<string, number>();
  private totalQueuedMessageBytes = 0;
  private messageWork = new Map<string, { tokens: number; updatedAt: number }>();
  private globalMessageWork = { tokens: 0, updatedAt: Date.now() };
  private acceptingMessages = true;
  private backgroundTasks = new Set<Promise<unknown>>();
  private lifecycleController = new AbortController();
  
  constructor(config: SyncManagerConfig) {
    super();
    this.config = {
      batchSize: 10,
      syncTimeout: 30000,
      maxCandidateBlockBytes: 16 * config.chainConfig.maxBlockSize,
      maxHeaderCandidates: MAX_HEADERS * 2,
      maxTransactionRequests: 500,
      maxTransactionRequestsPerPeer: 50,
      handshakeClockSkew: 120000,
      maxQueuedMessageBytes: 2 * config.chainConfig.maxBlockSize,
      maxTotalQueuedMessageBytes: 4 * config.chainConfig.maxBlockSize,
      messageWorkCapacity: 512,
      messageWorkRefillPerSecond: 128,
      globalMessageWorkCapacity: 4096,
      globalMessageWorkRefillPerSecond: 1024,
      ...config
    };
    this.globalMessageWork.tokens = this.config.globalMessageWorkCapacity!;
    
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
      if (!this.acceptingMessages) {
        this.config.connectionManager.disconnect(sessionId, 'sync manager stopped');
        return;
      }
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
      this.messageWork.delete(sessionId);
      this.headerRequests.delete(sessionId);
      for (const [hash, request] of this.transactionRequests) {
        if (request.sessionId === sessionId) this.transactionRequests.delete(hash);
      }
      if (this.activeSync?.sessionId === sessionId) this.abortSync('sync peer disconnected');
    });

    this.on('peer:ready', (peerId: string) => {
      const peer = this.config.discoveryService.getPeer(peerId);
      this.runTask(this.requestHeaders(peerId), `header request failed for ${peerId}`);
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
        if (message.command !== 'version' && message.command !== 'verack' &&
            !this.chargeMessageWork(sessionId, message.command, message.payload, data.length)) {
          this.config.connectionManager.disconnect(peerId, 'message work limit exceeded');
          return;
        }
        await this.handleMessage(peerId, sessionId, message.command, message.payload);
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
    this.syncPeerId = null;
    this.activeSync = null;
    this.headerRequests.clear();
    this.transactionRequests.clear();
    this.messageQueues.clear();
    this.queuedMessageBytes.clear();
    this.totalQueuedMessageBytes = 0;
    this.messageWork.clear();
    this.globalMessageWork = {
      tokens: this.config.globalMessageWorkCapacity!,
      updatedAt: Date.now()
    };
    this.handshakes.clear();
  }

  private chargeMessageWork(sessionId: string, command: string, payload: any, messageBytes: number): boolean {
    const now = Date.now();
    const refill = (bucket: { tokens: number; updatedAt: number }, capacity: number, rate: number) => {
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * rate / 1000);
      bucket.updatedAt = now;
    };
    let session = this.messageWork.get(sessionId);
    if (!session) {
      session = { tokens: this.config.messageWorkCapacity!, updatedAt: now };
      this.messageWork.set(sessionId, session);
    }
    refill(session, this.config.messageWorkCapacity!, this.config.messageWorkRefillPerSecond!);
    refill(
      this.globalMessageWork,
      this.config.globalMessageWorkCapacity!,
      this.config.globalMessageWorkRefillPerSecond!
    );

    const commandCost: Record<string, number> = {
      ping: 1,
      mempool: 2,
      inv: 2,
      tx: 8,
      block: 16,
      headers: 16,
      getdata: 4,
      getheaders: 8,
      getblocks: 8
    };
    const items = Array.isArray(payload) ? payload.length
      : Array.isArray(payload?.locator) ? payload.locator.length
      : Array.isArray(payload?.transactions) ? payload.transactions.length
      : 0;
    const cost = (commandCost[command] || 1) +
      Math.min(128, Math.ceil(Math.max(0, messageBytes - PROTOCOL_HEADER_SIZE) / 65536)) +
      Math.min(128, Math.ceil(items / 16));
    if (session.tokens < cost || this.globalMessageWork.tokens < cost) return false;
    session.tokens -= cost;
    this.globalMessageWork.tokens -= cost;
    return true;
  }
  
  /**
   * check if we need to sync with a peer
   */
  private async checkIfSyncNeeded(peer: PeerEndpoint): Promise<void> {
    if (!this.acceptingMessages) return;
    if (!this.config.connectionManager.isAuthenticated(peer.nodeId)) {
      const connected = await this.awaitOrStop(this.config.connectionManager.connectToPeer(peer));
      if (connected === undefined || !this.acceptingMessages) return;
      return;
    }
    await this.requestHeaders(peer.nodeId);
  }

  private async requestHeaders(peerId: string, headers: BlockHeader[] = []): Promise<void> {
    if (!this.acceptingMessages || this.activeSync || (this.validatingHeaders && headers.length === 0)) return;
    const connection = this.config.connectionManager.getConnection(peerId);
    if (!connection?.authenticated || this.headerRequests.has(connection.id)) return;
    const reservation = {
      peerId,
      sessionId: connection.id,
      deadline: Date.now() + this.config.syncTimeout!,
      headers
    };
    this.headerRequests.set(connection.id, reservation);
    const locator = await this.buildBlockLocator(headers.at(-1));
    if (!this.acceptingMessages || this.headerRequests.get(connection.id) !== reservation ||
        this.config.connectionManager.getConnection(peerId)?.id !== connection.id) {
      if (this.headerRequests.get(connection.id) === reservation) this.headerRequests.delete(connection.id);
      return;
    }
    const sent = this.config.connectionManager.sendMessage(peerId, this.config.protocol.encodeMessage('getheaders', {
      locator,
      stopHash: '0'.repeat(64)
    }));
    if (!sent) this.headerRequests.delete(connection.id);
  }

  private async buildBlockLocator(candidateTip?: BlockHeader): Promise<string[]> {
    const locator: string[] = [];
    if (candidateTip) locator.push(candidateTip.hash);
    let height = await this.config.blockchain.getHeight();
    let step = 1;
    while (height >= 0 && locator.length < 101) {
      const block = await this.config.blockchain.getBlock(height);
      if (block && !locator.includes(block.hash)) locator.push(block.hash);
      if (height === 0) break;
      height = Math.max(0, height - step);
      if (locator.length > 10) step *= 2;
    }
    return locator;
  }

  private requestNextBlock(): void {
    const sync = this.activeSync;
    if (!this.acceptingMessages || !sync) return;
    const header = sync.headers[sync.nextBlock];
    if (!header) {
      this.runTask(this.finishSync(sync), 'failed to finish sync');
      return;
    }
    const sent = this.config.connectionManager.sendMessage(sync.peerId, this.config.protocol.encodeMessage('getdata', [
      { type: InvType.BLOCK, hash: header.hash }
    ]));
    if (!sent) return this.abortSync('failed to request block');
    sync.deadline = Date.now() + this.config.syncTimeout!;
    this.blockTimeout = setTimeout(() => {
      if (this.activeSync === sync) {
        this.config.connectionManager.disconnect(sync.peerId, 'block request timed out');
        this.abortSync('block request timed out');
      }
    }, this.config.syncTimeout);
  }

  private async finishSync(sync: SyncCandidate): Promise<void> {
    if (this.activeSync !== sync) return;
    const currentTip = await this.config.blockchain.getLatestBlock();
    if (sync.ancestor.hash !== sync.canonicalTipHash) {
      const reorganized = await this.config.blockchain.reorganize(
        sync.ancestor.index,
        sync.blocks
      );
      if (!reorganized) return this.abortSync('candidate reorganization rejected');
    } else if (currentTip?.hash !== sync.headers.at(-1)?.hash) {
      return this.abortSync('canonical tip changed during sync');
    }

    this.activeSync = null;
    this.syncState = SyncState.SYNCED;
    this.syncPeerId = null;
    this.emit('sync:complete');
    if (sync.headers.length === MAX_HEADERS) await this.requestHeaders(sync.peerId);
    else this.requestMempool(sync.peerId);
  }

  private abortSync(reason: string): void {
    logger.warn(reason);
    if (this.blockTimeout) clearTimeout(this.blockTimeout);
    this.blockTimeout = null;
    this.activeSync = null;
    this.syncState = SyncState.IDLE;
    this.syncPeerId = null;
  }
  
  /**
   * handle incoming message from peer
   */
  private async handleMessage(peerId: string, sessionId: string, command: string, payload: any): Promise<void> {
    logger.debug(`received ${command} from ${peerId}`);
    
    switch (command) {
      case 'version':
        await this.handleVersion(peerId, payload);
        break;
      case 'verack':
        await this.handleVerack(peerId, payload);
        break;
      case 'block':
        await this.handleBlock(peerId, sessionId, payload);
        break;
      case 'headers':
        await this.handleHeaders(peerId, sessionId, payload);
        break;
      case 'tx':
        await this.handleTransaction(peerId, sessionId, payload);
        break;
      case 'inv':
        await this.handleInv(peerId, sessionId, payload);
        break;
      case 'ping':
        this.handlePing(peerId, payload);
        break;
      case 'getdata':
        await this.handleGetdata(peerId, payload);
        this.config.transactionRelay?.handleGetData(peerId, payload);
        break;
      case 'getheaders':
        await this.handleGetHeaders(peerId, payload);
        break;
      case 'getblocks':
        await this.handleGetBlocks(peerId, payload);
        break;
      case 'mempool':
        await this.config.transactionRelay?.syncMempool(peerId);
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
  private async handleBlock(peerId: string, sessionId: string, block: Block): Promise<void> {
    logger.info(`received block ${block.index} (${block.hash.substring(0, 8)}...) from ${peerId}`);
    const sync = this.activeSync;
    const expected = sync?.headers[sync.nextBlock];
    if (!sync || sync.peerId !== peerId || sync.sessionId !== sessionId || expected?.hash !== block.hash) return;
    if (this.blockTimeout) clearTimeout(this.blockTimeout);
    this.blockTimeout = null;

    const blockClass = BlockClass.fromObject(block);
    if (block.index !== expected.index || block.previousHash !== expected.previousHash ||
        block.merkleRoot !== expected.merkleRoot || block.stateRoot !== expected.stateRoot ||
        block.timestamp !== expected.timestamp || block.difficulty !== expected.difficulty ||
        block.nonce !== expected.nonce) {
      this.config.connectionManager.disconnect(peerId, 'block does not match validated header');
      return this.abortSync('block does not match validated header');
    }

    if (sync.ancestor.hash === sync.canonicalTipHash) {
      const result = await this.config.blockchain.addBlock(blockClass);
      if (!result.valid) {
        this.config.connectionManager.disconnect(peerId, 'invalid synchronized block');
        return this.abortSync(result.error || 'invalid synchronized block');
      }
    } else {
      const structure = blockClass.validate('sha256', this.config.chainConfig.maxTimeDrift * 1000);
      const size = blockClass.getSize();
      if (!structure.valid || size > this.config.chainConfig.maxBlockSize ||
          sync.blockBytes + size > this.config.maxCandidateBlockBytes!) {
        this.config.connectionManager.disconnect(peerId, 'invalid candidate block');
        return this.abortSync(structure.error || 'candidate block byte limit exceeded');
      }
      sync.blocks.push(blockClass.toObject());
      sync.blockBytes += size;
    }

    sync.nextBlock++;
    this.emit('block:received', blockClass);
    this.requestNextBlock();
  }

  private async handleHeaders(peerId: string, sessionId: string, payload: any[]): Promise<void> {
    const request = this.headerRequests.get(sessionId);
    if (!request || request.peerId !== peerId) return;
    const headers: BlockHeader[] = payload.map(header => ({
      index: header.height,
      timestamp: header.timestamp,
      previousHash: header.previousHash,
      hash: header.hash,
      merkleRoot: header.merkleRoot,
      stateRoot: header.stateRoot,
      difficulty: header.difficulty,
      nonce: header.nonce
    }));
    if (headers.length === 0) {
      this.headerRequests.delete(sessionId);
      if (request.headers.length === 0) this.requestMempool(peerId);
      return;
    }
    if (request.headers.length + headers.length > this.config.maxHeaderCandidates!) {
      this.headerRequests.delete(sessionId);
      return this.config.connectionManager.disconnect(peerId, 'header candidate limit exceeded');
    }
    const combined = [...request.headers, ...headers];
    const pendingHeaders = [...this.headerRequests.values()]
      .reduce((total, pending) => total + pending.headers.length, 0);
    if (pendingHeaders - request.headers.length + combined.length +
        (this.activeSync?.headers.length || 0) > this.config.maxHeaderCandidates!) {
      this.headerRequests.delete(sessionId);
      logger.warn(`global header candidate limit reached while processing ${peerId}`);
      return;
    }
    const reservation = { ...request, headers: combined };
    this.headerRequests.set(sessionId, reservation);
    if (this.activeSync || this.validatingHeaders) {
      this.headerRequests.delete(sessionId);
      return;
    }
    this.validatingHeaders = true;

    try {
      const validation = await this.config.blockchain.validateHeaderChain(combined);
      if (this.headerRequests.get(sessionId) !== reservation) return;
      if (!validation.valid || !validation.ancestor || validation.cumulativeDifficulty === undefined) {
        this.headerRequests.delete(sessionId);
        return this.config.connectionManager.disconnect(peerId, validation.error || 'invalid header chain');
      }
      const currentWork = await this.config.blockchain.getCumulativeDifficulty();
      if (this.headerRequests.get(sessionId) !== reservation) return;
      if (validation.cumulativeDifficulty <= currentWork) {
        this.headerRequests.delete(sessionId);
        if (headers.length === MAX_HEADERS) await this.requestHeaders(peerId, combined);
        return;
      }

      const tip = await this.config.blockchain.getLatestBlock();
      if (this.headerRequests.get(sessionId) !== reservation) return;
      if (!tip || this.activeSync) {
        this.headerRequests.delete(sessionId);
        return;
      }
      this.activeSync = {
        peerId,
        sessionId,
        deadline: Date.now() + this.config.syncTimeout!,
        ancestor: validation.ancestor,
        headers: combined,
        cumulativeDifficulty: validation.cumulativeDifficulty,
        canonicalTipHash: tip.hash,
        blocks: [],
        blockBytes: 0,
        nextBlock: 0
      };
      this.headerRequests.delete(sessionId);
      this.syncState = SyncState.SYNCING;
      this.syncPeerId = peerId;
      this.targetHeight = combined.at(-1)!.index;
      this.requestNextBlock();
    } finally {
      this.validatingHeaders = false;
    }
  }

  private async handleTransaction(peerId: string, sessionId: string, payload: any): Promise<void> {
    const request = this.transactionRequests.get(payload.hash);
    if (!request || request.peerId !== peerId || request.sessionId !== sessionId) return;
    this.transactionRequests.delete(payload.hash);
    await this.config.transactionRelay?.handleTransaction(peerId, payload);
  }
  
  /**
   * handle inventory message
   */
  private async handleInv(peerId: string, sessionId: string, items: any[]): Promise<void> {
    logger.debug(`received inv with ${items.length} items from ${peerId}`);
    const needed = await this.config.inventoryManager?.handleInv(peerId, items) || [];
    let peerRequests = 0;
    for (const request of this.transactionRequests.values()) {
      if (request.sessionId === sessionId) peerRequests++;
    }
    const available = Math.min(
      this.config.maxTransactionRequests! - this.transactionRequests.size,
      this.config.maxTransactionRequestsPerPeer! - peerRequests
    );
    const transactions = needed
      .filter(item => item.type === InvType.TX && !this.transactionRequests.has(item.hash))
      .slice(0, Math.max(0, available));
    if (transactions.length > 0) {
      const deadline = Date.now() + this.config.syncTimeout!;
      for (const item of transactions) this.transactionRequests.set(item.hash, { peerId, sessionId, deadline });
      if (!this.config.connectionManager.sendMessage(peerId, this.config.protocol.encodeMessage('getdata', transactions))) {
        for (const item of transactions) this.transactionRequests.delete(item.hash);
      }
    }
    if (needed.some(item => item.type === InvType.BLOCK)) await this.requestHeaders(peerId);
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
    if (this.config.connectionManager.sendMessage(peerId, message)) {
      this.config.inventoryManager?.markAnnounced(peerId, headers.map(header => ({
        type: InvType.BLOCK,
        hash: header.hash
      })));
    }
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
      if (this.config.connectionManager.sendMessage(peerId, message)) {
        this.config.inventoryManager?.markAnnounced(peerId, inventory);
      }
    }
  }
  
  /**
   * handle getdata message - respond with requested blocks/transactions
   */
  private async handleGetdata(peerId: string, items: any[]): Promise<void> {
    logger.info(`received getdata request for ${items.length} items from ${peerId}`);
    const blocks = items
      .filter(item => item.type === InvType.BLOCK)
      .slice(0, this.config.batchSize!);
    for (const item of blocks) {
      if (this.config.inventoryManager?.wasAnnouncedToPeer(peerId, item.type, item.hash)) {
        const block = await this.config.blockchain.getBlockByHash(item.hash);
        if (block) {
          logger.info(`sending block ${block.index} (${item.hash}) to ${peerId}`);
          const message = this.config.protocol.encodeMessage('block', block);
          if (!this.config.connectionManager.sendMessage(peerId, message)) return;
        } else {
          logger.warn(`requested block ${item.hash} not found`);
        }
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

  private requestMempool(peerId: string): void {
    this.config.connectionManager.sendMessage(peerId, this.config.protocol.encodeMessage('mempool', {}));
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
    if (!this.acceptingMessages) return;
    const now = Date.now();
    for (const [sessionId, request] of this.headerRequests) {
      if (request.deadline > now) continue;
      this.headerRequests.delete(sessionId);
      this.config.connectionManager.disconnect(request.peerId, 'header request timed out');
    }
    for (const [hash, request] of this.transactionRequests) {
      if (request.deadline <= now) this.transactionRequests.delete(hash);
    }
    if (this.activeSync || this.validatingHeaders) return;
    for (const peer of this.config.discoveryService.getKnownPeers()) {
      await this.checkIfSyncNeeded(peer);
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

  isSyncing(): boolean {
    return this.syncState === SyncState.SYNCING;
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
      syncPeer: this.syncPeerId
    };
  }
}
