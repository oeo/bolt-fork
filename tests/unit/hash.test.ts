import { describe, it, expect } from 'bun:test';
import { 
  hash, 
  calculateMerkleRoot, 
  difficultyToTarget,
  hashMeetsDifficulty,
  getHashSize
} from '../../src/crypto/hash';

describe('Hash Functions', () => {
  
  describe('hash()', () => {
    const testData = 'hello world';
    
    it('should hash with sha256', () => {
      const result = hash(testData, 'sha256');
      expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
      expect(result.length).toBe(64); // 32 bytes = 64 hex chars
    });
    
    it('should hash with sha512', () => {
      const result = hash(testData, 'sha512');
      expect(result.length).toBe(128); // 64 bytes = 128 hex chars
      expect(result).toBeTruthy();
    });
    
    it('should hash with double-sha256', () => {
      const result = hash(testData, 'double-sha256');
      expect(result.length).toBe(64);
      // double sha256 should be different from single
      const single = hash(testData, 'sha256');
      expect(result).not.toBe(single);
    });
    
    it('should hash with scrypt', () => {
      const result = hash(testData, 'scrypt', { N: 1024, r: 8, p: 1 });
      expect(result.length).toBe(64);
      expect(result).toBeTruthy();
    });
    
    it('should produce consistent results', () => {
      const hash1 = hash(testData, 'sha256');
      const hash2 = hash(testData, 'sha256');
      expect(hash1).toBe(hash2);
    });
  });
  
  describe('calculateMerkleRoot()', () => {
    it('should handle empty array', () => {
      const root = calculateMerkleRoot([]);
      expect(root).toBeTruthy();
    });
    
    it('should handle single hash', () => {
      const hashes = ['abc123'];
      const root = calculateMerkleRoot(hashes);
      expect(root).toBe('abc123');
    });
    
    it('should calculate merkle root for multiple hashes', () => {
      const hashes = [
        hash('tx1'),
        hash('tx2'),
        hash('tx3'),
        hash('tx4')
      ];
      const root = calculateMerkleRoot(hashes);
      expect(root).toBeTruthy();
      expect(root.length).toBe(64);
    });
    
    it('should work with different algorithms', () => {
      const hashes = [hash('tx1'), hash('tx2')];
      const rootSha256 = calculateMerkleRoot(hashes, 'sha256');
      const rootSha512 = calculateMerkleRoot(hashes, 'sha512');
      
      expect(rootSha256.length).toBe(64);
      expect(rootSha512.length).toBe(128);
      expect(rootSha256).not.toBe(rootSha512);
    });
  });
  
  describe('difficultyToTarget()', () => {
    it('should calculate target for difficulty 1', () => {
      const target = difficultyToTarget(1);
      const maxTarget = BigInt('0x' + 'FF'.repeat(32));
      expect(target).toBe(maxTarget);
    });
    
    it('should calculate smaller target for higher difficulty', () => {
      const target1 = difficultyToTarget(1);
      const target10 = difficultyToTarget(10);
      const target100 = difficultyToTarget(100);
      
      expect(target10 < target1).toBe(true);
      expect(target100 < target10).toBe(true);
    });
  });
  
  describe('hashMeetsDifficulty()', () => {
    it('should accept hash that meets difficulty', () => {
      // hash with leading zeros
      const easyHash = '00000000' + 'a'.repeat(56);
      expect(hashMeetsDifficulty(easyHash, 1)).toBe(true);
    });
    
    it('should reject hash that does not meet difficulty', () => {
      // hash with no leading zeros
      const hardHash = 'f'.repeat(64);
      expect(hashMeetsDifficulty(hardHash, 1000000)).toBe(false);
    });
    
    it('should work regardless of hash algorithm output', () => {
      // all algorithms produce hex strings that can be compared as bigints
      const sha256Hash = hash('test', 'sha256');
      const sha512Hash = hash('test', 'sha512');
      
      // both should meet very low difficulty
      expect(hashMeetsDifficulty(sha256Hash, 1)).toBe(true);
      expect(hashMeetsDifficulty(sha512Hash, 1)).toBe(true);
    });
  });
  
  
  describe('getHashSize()', () => {
    it('should return correct sizes', () => {
      expect(getHashSize('sha256')).toBe(32);
      expect(getHashSize('sha512')).toBe(64);
      expect(getHashSize('double-sha256')).toBe(32);
      expect(getHashSize('scrypt')).toBe(32);
    });
  });
});