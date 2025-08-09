import { Block, Transaction, ValidationResult } from '../types';
import { hash, calculateMerkleRoot, hashMeetsDifficulty, HashAlgorithm } from '../crypto/hash';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

/**
 * block class with mining and validation
 */
export class BlockClass {
  public index: number;
  public timestamp: number;
  public previousHash: string;
  public hash: string;
  public merkleRoot: string;
  public difficulty: number;
  public nonce: number;
  public transactions: Transaction[];
  public chainVersionHash: string;
  public miner?: string;
  
  constructor(
    index: number,
    timestamp: number,
    previousHash: string,
    transactions: Transaction[],
    difficulty: number,
    chainVersionHash: string,
    miner?: string
  ) {
    this.index = index;
    this.timestamp = timestamp;
    this.previousHash = previousHash;
    this.transactions = transactions;
    this.difficulty = difficulty;
    this.chainVersionHash = chainVersionHash;
    this.miner = miner;
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
    const block = new BlockClass(
      obj.index,
      obj.timestamp,
      obj.previousHash,
      obj.transactions,
      obj.difficulty,
      obj.chainVersionHash,
      obj.miner
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
      difficulty: this.difficulty,
      nonce: this.nonce,
      transactions: this.transactions,
      chainVersionHash: this.chainVersionHash,
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
    const data = [
      this.index.toString(),
      this.timestamp.toString(),
      this.previousHash,
      this.merkleRoot,
      this.difficulty.toString(),
      this.nonce.toString(),
      this.chainVersionHash
    ].join(':');
    
    return hash(data, algorithm);
  }
  
  /**
   * mine block with proof-of-work
   */
  mine(algorithm: HashAlgorithm = 'sha256', maxIterations: number = Number.MAX_SAFE_INTEGER): boolean {
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
        return true;
      }
      
      // log progress every million hashes
      if (iterations % 1000000 === 0) {
        logger.debug(`Mining progress: ${iterations} hashes computed`);
      }
    }
    
    logger.warn(`Mining stopped after ${maxIterations} iterations`);
    return false;
  }
  
  /**
   * validate block structure and hash
   */
  validate(algorithm: HashAlgorithm = 'sha256'): ValidationResult {
    // check index
    if (this.index < 0) {
      return { valid: false, error: 'Invalid block index' };
    }
    
    // check timestamp (not more than 2 hours in future)
    const maxFutureTime = Date.now() + (2 * 60 * 60 * 1000);
    if (this.timestamp > maxFutureTime) {
      return { valid: false, error: 'Block timestamp too far in future' };
    }
    
    // check merkle root
    const calculatedMerkleRoot = this.calculateMerkleRoot(algorithm);
    if (this.merkleRoot !== calculatedMerkleRoot) {
      return { valid: false, error: 'Invalid merkle root' };
    }
    
    // check hash calculation
    const calculatedHash = this.calculateHash(algorithm);
    if (this.hash !== calculatedHash) {
      return { valid: false, error: 'Invalid block hash' };
    }
    
    // check proof-of-work
    if (!hashMeetsDifficulty(this.hash, this.difficulty)) {
      return { valid: false, error: 'Block does not meet difficulty target' };
    }
    
    // check chain version hash
    if (!this.chainVersionHash || this.chainVersionHash.length !== 64) {
      return { valid: false, error: 'Invalid chain version hash' };
    }
    
    return { valid: true };
  }
  
  /**
   * validate against previous block
   */
  validatePreviousBlock(previousBlock: BlockClass): ValidationResult {
    // check index sequence
    if (this.index !== previousBlock.index + 1) {
      return { valid: false, error: 'Invalid block index sequence' };
    }
    
    // check previous hash link
    if (this.previousHash !== previousBlock.hash) {
      return { valid: false, error: 'Invalid previous hash link' };
    }
    
    // check timestamp (must be after previous block)
    if (this.timestamp <= previousBlock.timestamp) {
      return { valid: false, error: 'Block timestamp not after previous block' };
    }
    
    // check chain version consistency
    if (this.chainVersionHash !== previousBlock.chainVersionHash) {
      return { valid: false, error: 'Chain version hash mismatch' };
    }
    
    return { valid: true };
  }
  
  /**
   * validate against median timestamp of past blocks
   */
  validateMedianTime(pastBlocks: BlockClass[]): ValidationResult {
    if (pastBlocks.length === 0) {
      return { valid: true };
    }
    
    // get timestamps and sort them
    const timestamps = pastBlocks.map(b => b.timestamp).sort((a, b) => a - b);
    
    // calculate median
    const medianIndex = Math.floor(timestamps.length / 2);
    const medianTime = timestamps.length % 2 === 0
      ? (timestamps[medianIndex - 1] + timestamps[medianIndex]) / 2
      : timestamps[medianIndex];
    
    // block timestamp must be greater than median
    if (this.timestamp <= medianTime) {
      return { valid: false, error: 'Block timestamp not greater than median of past blocks' };
    }
    
    return { valid: true };
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
   * get block size in bytes (approximate)
   */
  getSize(): number {
    return JSON.stringify(this.toObject()).length;
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
  chainVersionHash: string,
  difficulty: number = 1,
  timestamp: number = Date.now(),
  algorithm: HashAlgorithm = 'sha256'
): BlockClass {
  const genesis = new BlockClass(
    0,
    timestamp,
    '0'.repeat(64),
    [],
    difficulty,
    chainVersionHash
  );
  
  // genesis block has special nonce
  genesis.nonce = 0;
  genesis.hash = genesis.calculateHash(algorithm);
  
  return genesis;
}