import { describe, it, expect } from 'bun:test';
import type { Block, Transaction, AccountState } from '../../src/types';

describe('Type Guards', () => {
  
  describe('Block type', () => {
    it('should have required fields', () => {
      const block: Block = {
        index: 0,
        timestamp: Date.now(),
        previousHash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: 'abcd1234',
        merkleRoot: '',
        difficulty: 10,
        nonce: 0,
        transactions: [],
        chainVersionHash: 'xyz789',
        miner: 'bolt1234567890'
      };
      
      expect(block.index).toBe(0);
      expect(block.difficulty).toBe(10);
      expect(block.chainVersionHash).toBeDefined();
    });
  });

  describe('Transaction type', () => {
    it('should handle coinbase transaction', () => {
      const coinbase: Transaction = {
        hash: 'tx123',
        from: null,
        to: 'bolt1234567890',
        amount: 5000000000n, // 50 BOLT
        nonce: 0,
        fee: 0n,
        timestamp: Date.now()
      };
      
      expect(coinbase.from).toBeNull();
      expect(coinbase.amount).toBe(5000000000n);
    });

    it('should handle regular transaction', () => {
      const tx: Transaction = {
        hash: 'tx456',
        from: 'bolt1111111111',
        to: 'bolt2222222222',
        amount: 100000000n, // 1 BOLT
        nonce: 1,
        fee: 10000n,
        signature: 'sig123',
        publicKey: 'pub123',
        timestamp: Date.now()
      };
      
      expect(tx.from).toBeDefined();
      expect(tx.signature).toBeDefined();
      expect(tx.fee).toBe(10000n);
    });
  });

  describe('AccountState type', () => {
    it('should store balance as bigint', () => {
      const account: AccountState = {
        balance: 1000000000000n, // 10000 BOLT
        nonce: 0
      };
      
      expect(typeof account.balance).toBe('bigint');
      expect(account.nonce).toBe(0);
    });
  });

});