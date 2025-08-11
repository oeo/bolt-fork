import { Block, Transaction } from '../types';
import { hash } from '../crypto/hash';
import { serialize, deserialize } from '../utils/bigint';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

// message types enum - bolt-specific protocol
export enum MessageType {
  // handshake
  BOLT_VERSION = 'bolt_version',
  BOLT_VERSION_ACK = 'bolt_version_ack',
  
  // block sync
  GET_BLOCKS = 'get_blocks',
  BLOCKS = 'blocks',
  GET_HEADERS = 'get_headers', 
  HEADERS = 'headers',
  
  // announcements
  NEW_BLOCK = 'new_block',
  NEW_TX = 'new_tx',
  
  // mempool
  GET_MEMPOOL = 'get_mempool',
  MEMPOOL_TXIDS = 'mempool_txids',
  
  // transactions
  GET_TXS = 'get_txs',
  TXS = 'txs',
  TX_INV = 'tx_inv',
  GET_TX = 'get_tx',
  TX = 'tx',
  
  // network
  GET_PEERS = 'get_peers',
  PEERS = 'peers',
  NODE_STATUS = 'node_status',
  
  // proof of work
  GET_MINING_TEMPLATE = 'get_mining_template',
  SUBMIT_BLOCK = 'submit_block',
  
  // control
  PING = 'ping',
  PONG = 'pong',
  REJECT = 'reject'
}

// base message interface
export interface NetworkMessage {
  type: MessageType;
  timestamp: number;
  nonce: string;
}

// version handshake - bolt specific
export interface BoltVersionMessage extends NetworkMessage {
  type: MessageType.BOLT_VERSION;
  protocolVersion: number; // bolt protocol version (1)
  network: string; // mainnet, testnet, devnet
  height: number;
  cumulativeDifficulty: bigint; // total chain work
  services: string[]; // ['mining', 'full_node', 'light']
  userAgent: string; // 'bolt-node/0.1.0'
}

export interface BoltVersionAckMessage extends NetworkMessage {
  type: MessageType.BOLT_VERSION_ACK;
  accepted: boolean;
  protocolVersion: number;
  reason?: string; // if rejected
}

// block messages
export interface GetBlocksMessage extends NetworkMessage {
  type: MessageType.GET_BLOCKS;
  startHeight: number;
  endHeight: number;
  maxBlocks?: number; // default 500
}

export interface BlocksMessage extends NetworkMessage {
  type: MessageType.BLOCKS;
  blocks: Block[];
}

export interface GetHeadersMessage extends NetworkMessage {
  type: MessageType.GET_HEADERS;
  startHeight: number;
  endHeight: number;
}

export interface HeadersMessage extends NetworkMessage {
  type: MessageType.HEADERS;
  headers: Array<{
    index: number;
    hash: string;
    previousHash: string;
    timestamp: number;
    difficulty: number;
    merkleRoot: string;
  }>;
}

export interface NewBlockMessage extends NetworkMessage {
  type: MessageType.NEW_BLOCK;
  block: Block;
  totalFees: bigint; // total fees in watts
  minerReward: bigint; // block reward in watts
}

// transaction messages
export interface NewTxMessage extends NetworkMessage {
  type: MessageType.NEW_TX;
  transaction: Transaction;
  feePerByte: bigint; // watts per byte for prioritization
}

export interface GetTxsMessage extends NetworkMessage {
  type: MessageType.GET_TXS;
  txHashes: string[];
}

export interface TxsMessage extends NetworkMessage {
  type: MessageType.TXS;
  transactions: Transaction[];
}

// mempool messages
export interface GetMempoolMessage extends NetworkMessage {
  type: MessageType.GET_MEMPOOL;
  minFeePerByte?: bigint; // only return txs with this fee or higher
  limit?: number;
}

export interface MempoolTxidsMessage extends NetworkMessage {
  type: MessageType.MEMPOOL_TXIDS;
  txids: string[]; // transaction hashes
  totalSize: number; // total mempool size
  minFee: bigint; // minimum fee in mempool (watts)
  maxFee: bigint; // maximum fee in mempool (watts)
}

// peer messages
export interface GetPeersMessage extends NetworkMessage {
  type: MessageType.GET_PEERS;
  limit?: number;
  minScore?: number; // minimum peer score
}

export interface PeersMessage extends NetworkMessage {
  type: MessageType.PEERS;
  peers: Array<{
    address: string; // multiaddr format
    lastSeen: number;
    services: string[];
    score: number; // peer reputation score
    height?: number; // their chain height
  }>;
}

// status message - bolt specific metrics
export interface NodeStatusMessage extends NetworkMessage {
  type: MessageType.NODE_STATUS;
  height: number;
  bestBlockHash: string;
  difficulty: number;
  cumulativeDifficulty: bigint;
  mempoolSize: number;
  mempoolBytes: number;
  connectedPeers: number;
  syncProgress?: number; // 0-100 percentage
  hashRate?: bigint; // hashes per second if mining
}

// mining messages (bolt specific)
export interface GetMiningTemplateMessage extends NetworkMessage {
  type: MessageType.GET_MINING_TEMPLATE;
  minerAddress: string;
  capabilities?: string[];
}

export interface SubmitBlockMessage extends NetworkMessage {
  type: MessageType.SUBMIT_BLOCK;
  block: Block;
  nonce: number;
  extraNonce?: string;
}

// control messages
export interface PingMessage extends NetworkMessage {
  type: MessageType.PING;
  blockHeight?: number; // include our height
}

export interface PongMessage extends NetworkMessage {
  type: MessageType.PONG;
  blockHeight?: number; // include our height
}

export interface RejectMessage extends NetworkMessage {
  type: MessageType.REJECT;
  rejectedType: MessageType;
  rejectedHash?: string; // hash of rejected item
  reason: string;
  code?: number; // error code
}

/**
 * message factory for creating network messages
 */
export class MessageFactory {
  private static generateNonce(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  static createBoltVersion(
    protocolVersion: number,
    network: string,
    height: number,
    cumulativeDifficulty: bigint,
    services: string[] = []
  ): BoltVersionMessage {
    return {
      type: MessageType.BOLT_VERSION,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      protocolVersion,
      network,
      height,
      cumulativeDifficulty,
      services,
      userAgent: 'bolt-node/0.1.0'
    };
  }

  static createBoltVersionAck(
    accepted: boolean,
    protocolVersion: number,
    reason?: string
  ): BoltVersionAckMessage {
    return {
      type: MessageType.BOLT_VERSION_ACK,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      accepted,
      protocolVersion,
      reason
    };
  }

  static createGetBlocks(
    startHeight: number,
    endHeight: number,
    maxBlocks?: number
  ): GetBlocksMessage {
    return {
      type: MessageType.GET_BLOCKS,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      startHeight,
      endHeight,
      maxBlocks
    };
  }

  static createBlocks(blocks: Block[]): BlocksMessage {
    return {
      type: MessageType.BLOCKS,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      blocks
    };
  }

  static createNewBlock(
    block: Block,
    totalFees: bigint,
    minerReward: bigint
  ): NewBlockMessage {
    return {
      type: MessageType.NEW_BLOCK,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      block,
      totalFees,
      minerReward
    };
  }

  static createNewTx(
    transaction: Transaction,
    feePerByte: bigint
  ): NewTxMessage {
    return {
      type: MessageType.NEW_TX,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      transaction,
      feePerByte
    };
  }

  static createNodeStatus(
    height: number,
    bestBlockHash: string,
    difficulty: number,
    cumulativeDifficulty: bigint,
    mempoolSize: number,
    mempoolBytes: number,
    connectedPeers: number,
    syncProgress?: number,
    hashRate?: bigint
  ): NodeStatusMessage {
    return {
      type: MessageType.NODE_STATUS,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      height,
      bestBlockHash,
      difficulty,
      cumulativeDifficulty,
      mempoolSize,
      mempoolBytes,
      connectedPeers,
      syncProgress,
      hashRate
    };
  }

  static createPing(blockHeight?: number): PingMessage {
    return {
      type: MessageType.PING,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      blockHeight
    };
  }

  static createPong(blockHeight?: number): PongMessage {
    return {
      type: MessageType.PONG,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      blockHeight
    };
  }

  static createReject(
    rejectedType: MessageType,
    reason: string,
    rejectedHash?: string,
    code?: number
  ): RejectMessage {
    return {
      type: MessageType.REJECT,
      timestamp: Date.now(),
      nonce: this.generateNonce(),
      rejectedType,
      rejectedHash,
      reason,
      code
    };
  }
}

/**
 * message validator for incoming messages
 */
export class MessageValidator {
  static readonly MAX_BLOCKS_PER_MESSAGE = 500;
  static readonly MAX_TX_PER_MESSAGE = 1000;
  static readonly MAX_MESSAGE_AGE = 60 * 1000; // 60 seconds
  static readonly PROTOCOL_VERSION = 1; // bolt protocol v1

  static validate(message: NetworkMessage): { valid: boolean; error?: string } {
    // check timestamp
    const age = Date.now() - message.timestamp;
    if (Math.abs(age) > this.MAX_MESSAGE_AGE) {
      return { valid: false, error: 'Message timestamp too old or in future' };
    }

    // check nonce
    if (!message.nonce || message.nonce.length < 8) {
      return { valid: false, error: 'Invalid message nonce' };
    }

    // validate specific message types
    switch (message.type) {
      case MessageType.BOLT_VERSION:
        return this.validateBoltVersion(message as BoltVersionMessage);
      case MessageType.GET_BLOCKS:
        return this.validateGetBlocks(message as GetBlocksMessage);
      case MessageType.BLOCKS:
        return this.validateBlocks(message as BlocksMessage);
      case MessageType.NEW_BLOCK:
        return this.validateNewBlock(message as NewBlockMessage);
      case MessageType.NEW_TX:
        return this.validateNewTx(message as NewTxMessage);
      default:
        return { valid: true };
    }
  }

  private static validateBoltVersion(msg: BoltVersionMessage): { valid: boolean; error?: string } {
    if (!msg.protocolVersion || !msg.network) {
      return { valid: false, error: 'Missing required version fields' };
    }

    if (msg.protocolVersion > this.PROTOCOL_VERSION) {
      return { valid: false, error: `Unsupported protocol version ${msg.protocolVersion}` };
    }

    if (msg.height < 0) {
      return { valid: false, error: 'Invalid block height' };
    }

    if (msg.cumulativeDifficulty < 0n) {
      return { valid: false, error: 'Invalid cumulative difficulty' };
    }

    return { valid: true };
  }

  private static validateGetBlocks(msg: GetBlocksMessage): { valid: boolean; error?: string } {
    if (msg.startHeight < 0 || msg.endHeight < msg.startHeight) {
      return { valid: false, error: 'Invalid block range' };
    }

    const range = msg.endHeight - msg.startHeight;
    if (range > this.MAX_BLOCKS_PER_MESSAGE) {
      return { valid: false, error: `Block range exceeds maximum of ${this.MAX_BLOCKS_PER_MESSAGE}` };
    }

    return { valid: true };
  }

  private static validateBlocks(msg: BlocksMessage): { valid: boolean; error?: string } {
    if (!Array.isArray(msg.blocks)) {
      return { valid: false, error: 'Blocks must be an array' };
    }

    if (msg.blocks.length > this.MAX_BLOCKS_PER_MESSAGE) {
      return { valid: false, error: `Too many blocks in message` };
    }

    return { valid: true };
  }

  private static validateNewBlock(msg: NewBlockMessage): { valid: boolean; error?: string } {
    if (!msg.block) {
      return { valid: false, error: 'Missing block data' };
    }

    if (!msg.block.hash || !msg.block.previousHash) {
      return { valid: false, error: 'Invalid block structure' };
    }

    if (msg.totalFees < 0n || msg.minerReward < 0n) {
      return { valid: false, error: 'Invalid fee or reward amounts' };
    }

    return { valid: true };
  }

  private static validateNewTx(msg: NewTxMessage): { valid: boolean; error?: string } {
    if (!msg.transaction) {
      return { valid: false, error: 'Missing transaction data' };
    }

    if (!msg.transaction.hash) {
      return { valid: false, error: 'Invalid transaction structure' };
    }

    if (msg.feePerByte < 0n) {
      return { valid: false, error: 'Invalid fee per byte' };
    }

    return { valid: true };
  }
}

/**
 * message serializer for network transmission
 */
export class MessageSerializer {
  static serialize(message: NetworkMessage): Uint8Array {
    // use our bigint-aware serializer
    const json = serialize(message);
    return new TextEncoder().encode(json);
  }

  static deserialize(data: Uint8Array): NetworkMessage {
    const json = new TextDecoder().decode(data);
    // use our bigint-aware deserializer
    const message = deserialize(json);

    // validate message has required fields
    if (!message.type || !message.timestamp || !message.nonce) {
      throw new Error('Invalid message format');
    }

    return message as NetworkMessage;
  }

  /**
   * calculate message hash for deduplication
   */
  static getMessageHash(message: NetworkMessage): string {
    const data = `${message.type}:${message.timestamp}:${message.nonce}`;
    return hash(data, 'sha256');
  }
}