import { describe, it, expect, beforeAll } from 'bun:test';
import { BlockClass, createGenesisBlock } from '../../src/core/block';
import { Transaction } from '../../src/types';
import { calculateTransactionHash } from '../../src/crypto/signature';

describe('Block Class', () => {
  let genesis: BlockClass;
  
  beforeAll(() => {
    genesis = createGenesisBlock(1, 1234567890);
  });
  
  describe('Genesis block', () => {
    it('should create valid genesis block', () => {
      expect(genesis.index).toBe(0);
      expect(genesis.previousHash).toBe('0'.repeat(64));
      expect(genesis.transactions.length).toBe(0);
      expect(genesis.difficulty).toBe(1);
      expect(genesis.hash).toBeTruthy();
    });
    
    it('should validate genesis block', () => {
      const result = genesis.validate();
      expect(result.valid).toBe(true);
    });
  });
  
  describe('Block creation', () => {
    it('should create block with transactions', () => {
      const tx1: Transaction = {
        hash: 'tx1',
        from: 'addr1',
        to: 'addr2',
        amount: 1000000n,
        nonce: 1,
        fee: 1000n,
        timestamp: Date.now()
      };
      
      const tx2: Transaction = {
        hash: 'tx2',
        from: 'addr2',
        to: 'addr3',
        amount: 2000000n,
        nonce: 1,
        fee: 2000n,
        timestamp: Date.now()
      };
      
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [tx1, tx2],
        10
      );
      
      expect(block.index).toBe(1);
      expect(block.transactions.length).toBe(2);
      expect(block.merkleRoot).toBeTruthy();
      expect(block.merkleRoot).not.toBe('0'.repeat(64));
    });
    
    it('should convert between object and class', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        10
      );
      
      block.nonce = 12345;
      block.hash = block.calculateHash();
      
      const obj = block.toObject();
      const restored = BlockClass.fromObject(obj);
      
      expect(restored.index).toBe(block.index);
      expect(restored.hash).toBe(block.hash);
      expect(restored.nonce).toBe(block.nonce);
      expect(restored.merkleRoot).toBe(block.merkleRoot);
    });
  });
  
  describe('Mining', () => {
    it('should mine block with low difficulty', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1 // very low difficulty
      );
      
      const result = block.mine('sha256', 100000);
      expect(result.success).toBe(true);
      expect(block.hash).toBeTruthy();
      expect(block.nonce).toBeGreaterThan(0);
    });
    
    it('should fail mining with high difficulty and low iterations', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1000000000 // very high difficulty
      );
      
      const result = block.mine('sha256', 10); // only 10 iterations
      expect(result.success).toBe(false);
    });
  });
  
  describe('Validation', () => {
    it('should validate correct block', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      
      block.mine('sha256', 100000);
      const result = block.validate();
      expect(result.valid).toBe(true);
    });
    
    it('should reject block with invalid index', () => {
      const block = new BlockClass(
        -1, // invalid
        Date.now(),
        genesis.hash,
        [],
        1
      );
      
      const result = block.validate();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('index');
    });
    
    it('should reject block with future timestamp', () => {
      const block = new BlockClass(
        1,
        Date.now() + (3 * 60 * 60 * 1000), // 3 hours in future
        genesis.hash,
        [],
        1
      );
      
      const result = block.validate();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('future');
    });
    
    it('should reject block with invalid hash', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      
      block.hash = 'invalid';
      const result = block.validate();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('hash');
    });
    
    it('should reject block not meeting difficulty', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1000 // high difficulty
      );
      
      block.nonce = 1;
      block.hash = block.calculateHash(); // likely won't meet difficulty
      
      const result = block.validate();
      expect(result.valid).toBe(false);
      expect(result.error).toContain('difficulty');
    });
  });
  
  describe('Previous block validation', () => {
    it('should validate correct sequence', () => {
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      block1.mine();
      
      const block2 = new BlockClass(
        2,
        Date.now() + 1000,
        block1.hash,
        [],
        1
      );
      
      const result = block2.validatePreviousBlock(block1);
      expect(result.valid).toBe(true);
    });
    
    it('should reject invalid index sequence', () => {
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      
      const block2 = new BlockClass(
        3, // should be 2
        Date.now(),
        block1.hash,
        [],
        1
      );
      
      const result = block2.validatePreviousBlock(block1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('index');
    });
    
    it('should reject invalid previous hash', () => {
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      
      const block2 = new BlockClass(
        2,
        Date.now(),
        'wrong_hash',
        [],
        1
      );
      
      const result = block2.validatePreviousBlock(block1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('previous hash');
    });
    
    it('should reject timestamp before previous block', () => {
      const block1 = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      block1.mine();
      
      const block2 = new BlockClass(
        2,
        Date.now() - 10000, // before block1
        block1.hash,
        [],
        1
      );
      
      const result = block2.validatePreviousBlock(block1);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timestamp');
    });
  });
  
  describe('Median time validation', () => {
    it('should validate against median time', () => {
      const pastBlocks = [
        new BlockClass(1, 1000, '', [], 1),
        new BlockClass(2, 2000, '', [], 1),
        new BlockClass(3, 3000, '', [], 1),
        new BlockClass(4, 4000, '', [], 1),
        new BlockClass(5, 5000, '', [], 1)
      ];
      
      // median is 3000
      const block = new BlockClass(6, 3001, '', [], 1);
      const result = block.validateMedianTime(pastBlocks);
      expect(result.valid).toBe(true);
    });
    
    it('should reject timestamp not greater than median', () => {
      const pastBlocks = [
        new BlockClass(1, 1000, '', [], 1),
        new BlockClass(2, 2000, '', [], 1),
        new BlockClass(3, 3000, '', [], 1)
      ];
      
      // median is 2000
      const block = new BlockClass(4, 2000, '', [], 1);
      const result = block.validateMedianTime(pastBlocks);
      expect(result.valid).toBe(false);
    });
  });
  
  describe('Coinbase transactions', () => {
    it('should validate correct coinbase', () => {
      const coinbase: Transaction = {
        hash: 'coinbase',
        from: null,
        to: 'miner_address',
        amount: 5000001000n, // 50 BOLT reward + 1000 fees
        nonce: 0,
        fee: 0n,
        timestamp: Date.now()
      };
      
      const regularTx: Transaction = {
        hash: 'tx1',
        from: 'addr1',
        to: 'addr2',
        amount: 1000000n,
        nonce: 1,
        fee: 1000n,
        timestamp: Date.now()
      };
      
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [coinbase, regularTx],
        1
      );
      
      const result = block.validateCoinbase(5000000000n); // 50 BOLT
      expect(result.valid).toBe(true);
    });
    
    it('should reject coinbase with wrong value', () => {
      const coinbase: Transaction = {
        hash: 'coinbase',
        from: null,
        to: 'miner_address',
        amount: 6000000000n, // too much!
        nonce: 0,
        fee: 0n,
        timestamp: Date.now()
      };
      
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [coinbase],
        1
      );
      
      const result = block.validateCoinbase(5000000000n);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('value');
    });
    
    it('should calculate total fees', () => {
      const tx1: Transaction = {
        hash: 'tx1',
        from: 'addr1',
        to: 'addr2',
        amount: 1000000n,
        nonce: 1,
        fee: 1000n,
        timestamp: Date.now()
      };
      
      const tx2: Transaction = {
        hash: 'tx2',
        from: 'addr2',
        to: 'addr3',
        amount: 2000000n,
        nonce: 1,
        fee: 2000n,
        timestamp: Date.now()
      };
      
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [tx1, tx2],
        1
      );
      
      const fees = block.calculateTotalFees();
      expect(fees).toBe(3000n);
    });
  });
  
  describe('Utility methods', () => {
    it('should check if transaction exists', () => {
      const tx: Transaction = {
        hash: 'tx123',
        from: 'addr1',
        to: 'addr2',
        amount: 1000000n,
        nonce: 1,
        fee: 1000n,
        timestamp: Date.now()
      };
      
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [tx],
        1
      );
      
      expect(block.hasTransaction('tx123')).toBe(true);
      expect(block.hasTransaction('tx456')).toBe(false);
    });
    
    it('should calculate block size', () => {
      const block = new BlockClass(
        1,
        Date.now(),
        genesis.hash,
        [],
        1
      );
      
      const size = block.getSize();
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(10000); // reasonable size for empty block
    });
  });
});