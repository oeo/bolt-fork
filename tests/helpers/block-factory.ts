/**
 * test helper for creating realistic blockchain data using bun's native crypto
 */

import type { Block } from '../../src/core/block';
import type { Transaction } from '../../src/core/transaction';

export class TestBlockFactory {
  /**
   * create a hash using bun's native crypto
   */
  static createHash(data: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(data);
    return hasher.digest("hex");
  }
  
  /**
   * create a test block with valid hashes
   */
  static createBlock(index: number): Block {
    return {
      index,
      previousHash: index === 0 
        ? '0'.repeat(64)
        : this.createHash(`block${index - 1}`),
      timestamp: Date.now(),
      transactions: [],
      nonce: Math.floor(Math.random() * 1000000),
      difficulty: 1,
      hash: this.createHash(`block${index}`),
      merkleRoot: this.createHash(`merkle${index}`),
      stateRoot: this.createHash(`state${index}`),
    };
  }
  
  /**
   * create a test transaction with valid hashes
   */
  static createTransaction(
    hash: string,
    from: string = 'sender',
    to: string = 'receiver',
    amount: bigint = 1000000n,
    fee: bigint = 1000n
  ): Transaction {
    return {
      chainId: 1057,
      kind: 'transfer',
      hash: this.createHash(hash),
      from,
      to,
      amount,
      fee,
      nonce: 1,
      timestamp: Date.now(),
      signature: this.createHash(`sig${hash}`),
    };
  }
  
  /**
   * create a chain of blocks
   */
  static createBlockchain(length: number): Block[] {
    const blocks: Block[] = [];
    for (let i = 0; i < length; i++) {
      const block = this.createBlock(i);
      if (i > 0) {
        // ensure proper chain linkage
        block.previousHash = blocks[i - 1].hash;
      }
      blocks.push(block);
    }
    return blocks;
  }
}
