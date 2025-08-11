// core blockchain types

export interface Block {
  index: number;
  timestamp: number;
  previousHash: string;
  hash: string;
  merkleRoot: string;
  difficulty: number;
  nonce: number;
  transactions: Transaction[];
  miner?: string;
}

export interface Transaction {
  hash: string;
  from: string | null; // null for coinbase transactions
  to: string;
  amount: bigint; // in satoshis (1 BOLT = 100,000,000 satoshis)
  nonce: number;
  fee: bigint;
  signature?: string;
  publicKey?: string;
  timestamp: number;
}

// account state (no separate wallet concept)
export interface AccountState {
  balance: bigint;
  nonce: number;
}

export interface DifficultyAdjustment {
  blockHeight: number;
  oldDifficulty: number;
  newDifficulty: number;
  actualTime: number;
  expectedTime: number;
  timestamp: number;
}

// storage adapter interface
export interface StorageAdapter {
  // block operations
  saveBlock(block: Block): Promise<void>;
  getBlock(height: number): Promise<Block | null>;
  getBlockByHash(hash: string): Promise<Block | null>;
  getLatestBlock(): Promise<Block | null>;
  getBlockRange(start: number, end: number): Promise<Block[]>;
  
  // wallet operations
  getWalletState(address: string): Promise<WalletState | null>;
  updateWalletState(address: string, state: WalletState): Promise<void>;
  
  // chain operations
  getCumulativeDifficulty(): Promise<bigint>;
  updateCumulativeDifficulty(difficulty: bigint): Promise<void>;
  
  // transaction operations
  getTransaction(hash: string): Promise<Transaction | null>;
  saveTransaction(tx: Transaction): Promise<void>;
  
  // utility
  close(): Promise<void>;
  clear(): Promise<void>;
}

// network message types
export interface VersionMessage {
  version: string;
  nodeId: string;
  timestamp: number;
  height: number;
  services: string[];
}

export interface BlockAnnounce {
  block: Block;
  nodeId: string;
}

export interface TransactionBroadcast {
  transaction: Transaction;
  nodeId: string;
}

export interface GetBlocks {
  startHeight: number;
  endHeight: number;
}

export interface PeerInfo {
  nodeId: string;
  multiaddrs: string[];
  protocols: string[];
  chainHeight: number;
  connectedAt: number;
  latency?: number;
  score: number;
}

// mining types
export interface BlockTemplate {
  // template identification
  templateId: string;
  createdAt: number;
  expiresAt: number;
  
  // block construction data
  version: number;
  height: number;
  previousHash: string;
  merkleRootPlaceholder: string;
  timestamp: number;
  difficulty: number;
  
  // mining data
  target: string;
  bits: string;
  
  // transaction data
  transactions: Transaction[];
  coinbaseTransaction: Transaction;
  coinbaseValue: bigint; // kept for compatibility
  totalFees: bigint;
  blockReward: bigint;
  
  // template metadata
  transactionCount: number;
  blockSizeBytes: number;
  sigOpsCount: number;
  
  // longpoll support
  longpollId: string;
  submitOld: boolean;
}

export interface BlockSubmission {
  templateId: string;
  nonce: number;
  timestamp?: number;
  coinbaseNonce?: string;
}

export interface BlockTemplateRequest {
  capabilities?: string[];
  longpollId?: string;
  maxVersionBits?: number;
}

export interface MiningJob {
  id: string;
  template: BlockTemplate;
  startTime: number;
  targetHash: string;
}

// mempool types
export interface MempoolEntry {
  transaction: Transaction;
  addedAt: number;
  feePerByte: bigint;
}

// validation types
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface ChainValidationState {
  height: number;
  cumulativeDifficulty: bigint;
  lastValidatedBlock: string;
  timestamp: number;
}