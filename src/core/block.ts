import { Block, Transaction, ValidationResult } from '../types';
import { hash, calculateMerkleRoot, hashMeetsDifficulty, HashAlgorithm } from '../crypto/hash';
import { getLogger } from '../utils/logger';

export type { Block } from '../types';

const logger = getLogger(__filename);

export interface BlockHeader {
  index: number;
  timestamp: number;
  previousHash: string;
  hash: string;
  merkleRoot: string;
  stateRoot: string;
  difficulty: number;
  nonce: number;
}

export function calculateBlockHeaderHash(
  header: Omit<BlockHeader, 'hash'>,
  algorithm: HashAlgorithm = 'sha256'
): string {
  return hash([
    header.index.toString(),
    header.timestamp.toString(),
    header.previousHash,
    header.merkleRoot,
    header.stateRoot,
    header.difficulty.toString(),
    header.nonce.toString()
  ].join(':'), algorithm);
}

export function validateBlockHeader(
  header: BlockHeader,
  maxFutureTime: number,
  algorithm: HashAlgorithm = 'sha256'
): ValidationResult {
  if (!Number.isSafeInteger(header.index) || header.index < 0) {
    return { valid: false, error: 'Invalid block index' };
  }
  if (!Number.isSafeInteger(header.timestamp) || header.timestamp < 0) {
    return { valid: false, error: 'Invalid block timestamp' };
  }
  if (!Number.isSafeInteger(header.nonce) || header.nonce < 0) {
    return { valid: false, error: 'Invalid block nonce' };
  }
  if (!Number.isSafeInteger(header.difficulty) || header.difficulty < 1) {
    return { valid: false, error: 'Invalid block difficulty' };
  }
  if (header.timestamp > Date.now() + maxFutureTime) {
    return { valid: false, error: 'Block timestamp too far in future' };
  }
  if (![header.previousHash, header.hash, header.merkleRoot]
    .every(value => /^[0-9a-f]{64}$/.test(value))) {
    return { valid: false, error: 'Invalid block header hash' };
  }
  if (header.stateRoot !== '' && !/^[0-9a-f]{64}$/.test(header.stateRoot)) {
    return { valid: false, error: 'Invalid block state root' };
  }
  if (header.hash !== calculateBlockHeaderHash(header, algorithm)) {
    return { valid: false, error: 'Invalid block hash' };
  }
  if (!hashMeetsDifficulty(header.hash, header.difficulty)) {
    return { valid: false, error: 'Block does not meet difficulty target' };
  }
  return { valid: true };
}

export function validateBlockHeaderPrevious(
  header: BlockHeader,
  previous: BlockHeader
): ValidationResult {
  if (header.index !== previous.index + 1) {
    return { valid: false, error: 'Invalid block index sequence' };
  }
  if (header.previousHash !== previous.hash) {
    return { valid: false, error: 'Invalid previous hash link' };
  }
  if (header.timestamp <= previous.timestamp) {
    return { valid: false, error: 'Block timestamp not after previous block' };
  }
  return { valid: true };
}

export function validateBlockHeaderMedianTime(
  header: BlockHeader,
  pastHeaders: BlockHeader[]
): ValidationResult {
  if (pastHeaders.length === 0) return { valid: true };
  const timestamps = pastHeaders.map(block => block.timestamp).sort((a, b) => a - b);
  const middle = Math.floor(timestamps.length / 2);
  const median = timestamps.length % 2 === 0
    ? (timestamps[middle - 1] + timestamps[middle]) / 2
    : timestamps[middle];
  return header.timestamp > median
    ? { valid: true }
    : { valid: false, error: 'Block timestamp not greater than median of past blocks' };
}

/**
 * block class with mining and validation
 */
export class BlockClass {
  public index: number;
  public timestamp: number;
  public previousHash: string;
  public hash: string;
  public merkleRoot: string;
  public stateRoot: string;
  public difficulty: number;
  public nonce: number;
  public transactions: Transaction[];
  public miner?: string;
  
  constructor(
    index: number,
    timestamp: number,
    previousHash: string,
    transactions: Transaction[],
    difficulty: number,
    miner?: string,
    stateRoot: string = ''
  ) {
    this.index = index;
    this.timestamp = timestamp;
    this.previousHash = previousHash;
    this.transactions = transactions;
    this.difficulty = difficulty;
    this.miner = miner;
    this.stateRoot = stateRoot;
    this.nonce = 0;
    
    // calculate merkle root from transactions
    this.merkleRoot = this.calculateMerkleRoot();
    
    // hash will be calculated during mining
    this.hash = '';
  }
  
  /**
   * create block from plain object
   */
  static fromObject(obj: Block): BlockClass {
    const { TransactionClass } = require('./transaction');
    
    // convert transactions to TransactionClass instances if they aren't already
    const transactions = obj.transactions.map(tx => 
      tx instanceof TransactionClass ? tx : TransactionClass.fromObject(tx)
    );
    
    const block = new BlockClass(
      obj.index,
      obj.timestamp,
      obj.previousHash,
      transactions,
      obj.difficulty,
      obj.miner,
      obj.stateRoot
    );
    
    block.hash = obj.hash;
    block.nonce = obj.nonce;
    block.merkleRoot = obj.merkleRoot;
    
    return block;
  }
  
  /**
   * convert to plain object
   */
  toObject(): Block {
    return {
      index: this.index,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      hash: this.hash,
      merkleRoot: this.merkleRoot,
      stateRoot: this.stateRoot,
      difficulty: this.difficulty,
      nonce: this.nonce,
      transactions: this.transactions,
      miner: this.miner
    };
  }
  
  /**
   * calculate merkle root from transactions
   */
  calculateMerkleRoot(algorithm: HashAlgorithm = 'sha256'): string {
    if (this.transactions.length === 0) {
      return hash('', algorithm);
    }
    
    const txHashes = this.transactions.map(tx => tx.hash);
    return calculateMerkleRoot(txHashes, algorithm);
  }
  
  /**
   * calculate block hash
   */
  calculateHash(algorithm: HashAlgorithm = 'sha256'): string {
    return calculateBlockHeaderHash(this, algorithm);
  }
  
  /**
   * mine block with proof-of-work
   * @returns object with success status and mining stats
   */
  mine(algorithm: HashAlgorithm = 'sha256', maxIterations: number = Number.MAX_SAFE_INTEGER): { success: boolean; iterations: number; timeMs: number } {
    logger.info(`Mining block ${this.index} with difficulty ${this.difficulty}`);
    const startTime = Date.now();
    let iterations = 0;
    
    while (iterations < maxIterations) {
      this.nonce++;
      iterations++;
      this.hash = this.calculateHash(algorithm);
      
      if (hashMeetsDifficulty(this.hash, this.difficulty)) {
        const elapsed = Date.now() - startTime;
        logger.info(`Block ${this.index} mined in ${elapsed}ms after ${iterations} iterations`);
        logger.debug(`Block hash: ${this.hash}`);
        return { success: true, iterations, timeMs: elapsed };
      }
      
      // log progress every million hashes
      if (iterations % 1000000 === 0) {
        logger.debug(`Mining progress: ${iterations} hashes computed`);
      }
    }
    
    const elapsed = Date.now() - startTime;
    logger.warn(`Mining stopped after ${maxIterations} iterations`);
    return { success: false, iterations: maxIterations, timeMs: elapsed };
  }
  
  /**
   * validate block structure and hash
   */
  validate(algorithm: HashAlgorithm = 'sha256', maxFutureTime = 2 * 60 * 60 * 1000): ValidationResult {
    // check merkle root
    const calculatedMerkleRoot = this.calculateMerkleRoot(algorithm);
    if (this.merkleRoot !== calculatedMerkleRoot) {
      return { valid: false, error: 'Invalid merkle root' };
    }
    return validateBlockHeader(this, maxFutureTime, algorithm);
  }
  
  /**
   * validate against previous block
   */
  validatePreviousBlock(previousBlock: BlockClass): ValidationResult {
    return validateBlockHeaderPrevious(this, previousBlock);
  }
  
  /**
   * validate against median timestamp of past blocks
   */
  validateMedianTime(pastBlocks: BlockClass[]): ValidationResult {
    return validateBlockHeaderMedianTime(this, pastBlocks);
  }
  
  /**
   * validate difficulty matches expected
   */
  validateDifficulty(expectedDifficulty: number): ValidationResult {
    if (this.difficulty !== expectedDifficulty) {
      return { 
        valid: false, 
        error: `Invalid difficulty: expected ${expectedDifficulty}, got ${this.difficulty}` 
      };
    }
    
    return { valid: true };
  }

  /**
   * validate serialized block size
   */
  validateSize(maxSize: number): ValidationResult {
    const size = this.getSize();
    if (size > maxSize) {
      return { valid: false, error: `Block too large: ${size} > ${maxSize}` };
    }

    return { valid: true };
  }
  
  /**
   * calculate total fees from transactions
   */
  calculateTotalFees(): bigint {
    return this.transactions.reduce((total, tx) => total + tx.fee, 0n);
  }
  
  /**
   * get coinbase transaction (first transaction)
   */
  getCoinbaseTransaction(): Transaction | null {
    if (this.transactions.length === 0) {
      return null;
    }
    
    const coinbase = this.transactions[0];
    
    // coinbase transaction has no sender
    if (coinbase.from !== null) {
      return null;
    }
    
    return coinbase;
  }
  
  /**
   * validate coinbase transaction
   */
  validateCoinbase(expectedReward: bigint): ValidationResult {
    const coinbase = this.getCoinbaseTransaction();
    
    if (!coinbase) {
      return { valid: false, error: 'No coinbase transaction found' };
    }

    if (this.transactions.slice(1).some(tx => tx.from === null)) {
      return { valid: false, error: 'Only first transaction may be coinbase' };
    }
    
    // calculate total fees from other transactions
    const fees = this.transactions
      .slice(1)
      .reduce((total, tx) => total + tx.fee, 0n);
    
    // coinbase value should be block reward + fees
    const expectedValue = expectedReward + fees;
    
    if (coinbase.amount !== expectedValue) {
      return { 
        valid: false, 
        error: `Invalid coinbase value: expected ${expectedValue}, got ${coinbase.amount}` 
      };
    }
    
    // coinbase should have no fee
    if (coinbase.fee !== 0n) {
      return { valid: false, error: 'Coinbase transaction should have no fee' };
    }
    
    // coinbase should have nonce 0
    if (coinbase.nonce !== 0) {
      return { valid: false, error: 'Coinbase transaction should have nonce 0' };
    }
    
    return { valid: true };
  }
  
  /**
   * get serialized block size in bytes
   */
  getSize(): number {
    const { serialize } = require('../utils/bigint');
    const { miner: _miner, ...consensusBlock } = this.toObject();
    return new TextEncoder().encode(serialize(consensusBlock)).byteLength;
  }
  
  /**
   * check if block contains transaction
   */
  hasTransaction(txHash: string): boolean {
    return this.transactions.some(tx => tx.hash === txHash);
  }
}

/**
 * create genesis block
 */
export function createGenesisBlock(
  difficulty: number,
  timestamp: number,
  stateRoot: string,
  nonce: number
): BlockClass {
  const genesis = new BlockClass(
    0,
    timestamp,
    '0'.repeat(64),
    [],
    difficulty,
    undefined,
    stateRoot
  );
  
  genesis.nonce = nonce;
  genesis.hash = genesis.calculateHash('sha256');
  
  return genesis;
}
