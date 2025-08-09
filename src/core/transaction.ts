import { Transaction, ValidationResult } from '../types';
import {
  calculateTransactionHash,
  signTransaction,
  verifyTransaction,
  serializeTransactionData
} from '../crypto/signature';
import { validateAddress } from '../crypto/address';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

/**
 * transaction class with validation and signing
 */
export class TransactionClass {
  public hash: string;
  public from: string | null; // null for coinbase
  public to: string;
  public amount: bigint;
  public nonce: number;
  public fee: bigint;
  public signature?: string;
  public publicKey?: string;
  public timestamp: number;

  constructor(
    from: string | null,
    to: string,
    amount: bigint,
    nonce: number,
    fee: bigint,
    timestamp: number = Date.now()
  ) {
    this.from = from;
    this.to = to;
    this.amount = amount;
    this.nonce = nonce;
    this.fee = fee;
    this.timestamp = timestamp;

    // hash will be calculated after signing (or immediately for coinbase)
    this.hash = '';

    // if coinbase, calculate hash immediately
    if (this.from === null) {
      this.hash = this.calculateHash();
    }
  }

  /**
   * create transaction from plain object
   */
  static fromObject(obj: Transaction): TransactionClass {
    const tx = new TransactionClass(
      obj.from,
      obj.to,
      BigInt(obj.amount),
      obj.nonce,
      BigInt(obj.fee),
      obj.timestamp
    );

    tx.hash = obj.hash;
    tx.signature = obj.signature;
    tx.publicKey = obj.publicKey;

    return tx;
  }

  /**
   * convert to plain object
   */
  toObject(): Transaction {
    return {
      hash: this.hash,
      from: this.from,
      to: this.to,
      amount: this.amount,
      nonce: this.nonce,
      fee: this.fee,
      signature: this.signature,
      publicKey: this.publicKey,
      timestamp: this.timestamp
    };
  }

  /**
   * calculate transaction hash
   */
  calculateHash(): string {
    return calculateTransactionHash(
      {
        from: this.from,
        to: this.to,
        amount: this.amount,
        nonce: this.nonce,
        fee: this.fee,
        timestamp: this.timestamp
      },
      this.signature
    );
  }

  /**
   * sign transaction with private key
   */
  async sign(privateKey: Uint8Array | string): Promise<void> {
    if (this.from === null) {
      throw new Error('Cannot sign coinbase transaction');
    }

    const { signature, publicKey } = await signTransaction(
      {
        from: this.from,
        to: this.to,
        amount: this.amount,
        nonce: this.nonce,
        fee: this.fee,
        timestamp: this.timestamp
      },
      privateKey
    );

    this.signature = signature;
    this.publicKey = publicKey;
    this.hash = this.calculateHash();

    logger.debug(`Transaction signed: ${this.hash}`);
  }

  /**
   * verify transaction signature
   */
  async verify(): Promise<boolean> {
    if (this.from === null) {
      // coinbase transactions don't have signatures
      return true;
    }

    if (!this.signature || !this.publicKey) {
      return false;
    }

    return verifyTransaction(
      {
        from: this.from,
        to: this.to,
        amount: this.amount,
        nonce: this.nonce,
        fee: this.fee,
        timestamp: this.timestamp
      },
      this.signature,
      this.publicKey
    );
  }

  /**
   * validate transaction structure and data
   */
  validate(): ValidationResult {
    // if hash not set yet (unsigned tx), calculate it
    if (!this.hash) {
      this.hash = this.calculateHash();
    }

    // check hash
    const calculatedHash = this.calculateHash();
    if (this.hash !== calculatedHash) {
      return { valid: false, error: 'Invalid transaction hash' };
    }

    // check addresses
    if (!validateAddress(this.to)) {
      return { valid: false, error: 'Invalid recipient address' };
    }

    if (this.from !== null && !validateAddress(this.from)) {
      return { valid: false, error: 'Invalid sender address' };
    }

    // check amounts
    if (this.amount < 0n) {
      return { valid: false, error: 'Negative amount not allowed' };
    }

    if (this.fee < 0n) {
      return { valid: false, error: 'Negative fee not allowed' };
    }

    // check nonce
    if (this.nonce < 0) {
      return { valid: false, error: 'Invalid nonce' };
    }

    // coinbase specific checks
    if (this.from === null) {
      if (this.nonce !== 0) {
        return { valid: false, error: 'Coinbase transaction must have nonce 0' };
      }

      if (this.fee !== 0n) {
        return { valid: false, error: 'Coinbase transaction must have fee 0' };
      }

      if (this.signature || this.publicKey) {
        return { valid: false, error: 'Coinbase transaction should not have signature' };
      }
    } else {
      // regular transaction checks
      if (!this.signature || !this.publicKey) {
        return { valid: false, error: 'Regular transaction must be signed' };
      }
    }

    // check timestamp
    const maxFutureTime = Date.now() + (15 * 60 * 1000); // 15 minutes
    if (this.timestamp > maxFutureTime) {
      return { valid: false, error: 'Transaction timestamp too far in future' };
    }

    return { valid: true };
  }

  /**
   * validate transaction against account state
   */
  validateAgainstAccount(
    senderBalance: bigint,
    senderNonce: number
  ): ValidationResult {
    if (this.from === null) {
      // coinbase doesn't need account validation
      return { valid: true };
    }

    // check balance
    const totalCost = this.amount + this.fee;
    if (senderBalance < totalCost) {
      return {
        valid: false,
        error: `Insufficient balance: have ${senderBalance}, need ${totalCost}`
      };
    }

    // check nonce - should match expected next nonce
    if (this.nonce !== senderNonce) {
      return {
        valid: false,
        error: `Invalid nonce: expected ${senderNonce}, got ${this.nonce}`
      };
    }

    return { valid: true };
  }

  /**
   * check if transaction is coinbase
   */
  isCoinbase(): boolean {
    return this.from === null;
  }

  /**
   * get transaction size in bytes (approximate)
   */
  getSize(): number {
    const obj = {
      ...this.toObject(),
      amount: this.amount.toString(),
      fee: this.fee.toString()
    };
    return JSON.stringify(obj).length;
  }

  /**
   * serialize for network transmission
   */
  serialize(): string {
    const obj = {
      ...this.toObject(),
      amount: this.amount.toString(),
      fee: this.fee.toString()
    };
    return JSON.stringify(obj);
  }

  /**
   * deserialize from network transmission
   */
  static deserialize(data: string): TransactionClass {
    const obj = JSON.parse(data);
    // convert string amounts back to bigint
    obj.amount = BigInt(obj.amount);
    obj.fee = BigInt(obj.fee);
    return TransactionClass.fromObject(obj);
  }
}

/**
 * create coinbase transaction
 */
export function createCoinbaseTransaction(
  minerAddress: string,
  blockReward: bigint,
  fees: bigint,
  timestamp: number = Date.now()
): TransactionClass {
  const coinbase = new TransactionClass(
    null, // coinbase has no sender
    minerAddress,
    blockReward + fees,
    0, // coinbase always has nonce 0
    0n, // coinbase has no fee
    timestamp
  );

  logger.debug(`Created coinbase transaction: reward=${blockReward}, fees=${fees}`);

  return coinbase;
}

/**
 * calculate the size of a transaction in bytes
 */
export function getTransactionSize(tx: Transaction): number {
  const txClass = TransactionClass.fromObject(tx);
  return txClass.getSize();
}

/**
 * create and sign regular transaction
 */
export async function createSignedTransaction(
  from: string,
  to: string,
  amount: bigint,
  nonce: number,
  fee: bigint,
  privateKey: Uint8Array | string,
  timestamp: number = Date.now()
): Promise<TransactionClass> {
  const tx = new TransactionClass(from, to, amount, nonce, fee, timestamp);
  await tx.sign(privateKey);
  return tx;
}

/**
 * calculate minimum fee based on transaction size
 */
export function calculateMinimumFee(txSize: number, feePerByte: bigint = 1n): bigint {
  return BigInt(txSize) * feePerByte;
}

/**
 * validate transaction pool (mempool) for conflicts
 */
export function validateTransactionPool(
  transactions: TransactionClass[]
): ValidationResult {
  // check for duplicate transactions
  const hashes = new Set<string>();
  for (const tx of transactions) {
    if (hashes.has(tx.hash)) {
      return { valid: false, error: `Duplicate transaction: ${tx.hash}` };
    }
    hashes.add(tx.hash);
  }

  // check for conflicting nonces from same sender
  const nonces = new Map<string, Set<number>>();
  for (const tx of transactions) {
    if (tx.from === null) continue; // skip coinbase

    if (!nonces.has(tx.from)) {
      nonces.set(tx.from, new Set());
    }

    const senderNonces = nonces.get(tx.from)!;
    if (senderNonces.has(tx.nonce)) {
      return {
        valid: false,
        error: `Duplicate nonce ${tx.nonce} from sender ${tx.from}`
      };
    }
    senderNonces.add(tx.nonce);
  }

  return { valid: true };
}
