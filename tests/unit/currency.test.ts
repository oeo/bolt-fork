import { describe, it, expect } from 'bun:test';
import {
  wattsToBolt,
  formatWatts,
  boltToWatts,
  parseAmount,
  formatFee
} from '../../src/utils/currency';

describe('Currency Utilities', () => {
  
  describe('wattsToBolt', () => {
    it('should convert whole BOLT amounts', () => {
      expect(wattsToBolt(100_000_000n)).toBe('1 BOLT');
      expect(wattsToBolt(5_000_000_000n)).toBe('50 BOLT');
      expect(wattsToBolt(2_100_000_000_000_000n)).toBe('21000000 BOLT');
    });
    
    it('should handle fractional BOLT amounts', () => {
      expect(wattsToBolt(150_000_000n)).toBe('1.5 BOLT');
      expect(wattsToBolt(100_000_001n)).toBe('1.00000001 BOLT');
      expect(wattsToBolt(123_456_789n)).toBe('1.23456789 BOLT');
    });
    
    it('should remove trailing zeros', () => {
      expect(wattsToBolt(150_000_000n)).toBe('1.5 BOLT');
      expect(wattsToBolt(100_100_000n)).toBe('1.001 BOLT');
      expect(wattsToBolt(100_000_100n)).toBe('1.000001 BOLT');
    });
    
    it('should handle zero', () => {
      expect(wattsToBolt(0n)).toBe('0 BOLT');
    });
    
    it('should handle small amounts', () => {
      expect(wattsToBolt(1n)).toBe('0.00000001 BOLT');
      expect(wattsToBolt(100n)).toBe('0.000001 BOLT');
      expect(wattsToBolt(99_999_999n)).toBe('0.99999999 BOLT');
    });
  });
  
  describe('formatWatts', () => {
    it('should display small amounts as watts', () => {
      expect(formatWatts(1n)).toBe('1 watt');
      expect(formatWatts(2n)).toBe('2 watts');
      expect(formatWatts(1000n)).toBe('1000 watts');
      expect(formatWatts(99_999_999n)).toBe('99999999 watts');
    });
    
    it('should display large amounts as BOLT', () => {
      expect(formatWatts(100_000_000n)).toBe('1 BOLT');
      expect(formatWatts(150_000_000n)).toBe('1.5 BOLT');
      expect(formatWatts(5_000_000_000n)).toBe('50 BOLT');
    });
  });
  
  describe('boltToWatts', () => {
    it('should convert whole BOLT to watts', () => {
      expect(boltToWatts(1)).toBe(100_000_000n);
      expect(boltToWatts(50)).toBe(5_000_000_000n);
      expect(boltToWatts(21_000_000)).toBe(2_100_000_000_000_000n);
    });
    
    it('should convert fractional BOLT to watts', () => {
      expect(boltToWatts(0.5)).toBe(50_000_000n);
      expect(boltToWatts(0.00000001)).toBe(1n);
      expect(boltToWatts(1.23456789)).toBe(123_456_789n);
      expect(boltToWatts('1.23456789')).toBe(123_456_789n); // string version should be exact
    });
    
    it('should handle string input', () => {
      expect(boltToWatts('1')).toBe(100_000_000n);
      expect(boltToWatts('0.5')).toBe(50_000_000n);
      expect(boltToWatts('1.23456789')).toBe(123_456_789n);
    });
    
    it('should handle zero', () => {
      expect(boltToWatts(0)).toBe(0n);
      expect(boltToWatts('0')).toBe(0n);
    });
    
    it('should throw on invalid input', () => {
      expect(() => boltToWatts('invalid')).toThrow('Invalid BOLT amount');
      expect(() => boltToWatts('abc')).toThrow('Invalid BOLT amount');
    });
  });
  
  describe('parseAmount', () => {
    it('should parse explicit watts', () => {
      expect(parseAmount('1000 watts')).toBe(1000n);
      expect(parseAmount('1 watt')).toBe(1n);
      expect(parseAmount('5000000000 watts')).toBe(5_000_000_000n);
      expect(parseAmount('1000w')).toBe(1000n);
    });
    
    it('should parse explicit BOLT', () => {
      expect(parseAmount('1 BOLT')).toBe(100_000_000n);
      expect(parseAmount('50 bolt')).toBe(5_000_000_000n);
      expect(parseAmount('0.5 BOLT')).toBe(50_000_000n);
    });
    
    it('should assume BOLT for decimal numbers', () => {
      expect(parseAmount('1.5')).toBe(150_000_000n);
      expect(parseAmount('0.00000001')).toBe(1n);
    });
    
    it('should intelligently guess for whole numbers', () => {
      // small numbers assumed to be BOLT
      expect(parseAmount('1')).toBe(100_000_000n);
      expect(parseAmount('50')).toBe(5_000_000_000n);
      expect(parseAmount('100')).toBe(10_000_000_000n);
      
      // large numbers assumed to be watts
      expect(parseAmount('1000000')).toBe(1_000_000n);
      expect(parseAmount('100000000')).toBe(100_000_000n);
    });
    
    it('should handle mixed case and spacing', () => {
      expect(parseAmount(' 50 BOLT ')).toBe(5_000_000_000n);
      expect(parseAmount('1000 WATTS')).toBe(1000n);
      expect(parseAmount('  100W  ')).toBe(100n);
    });
  });
  
  describe('formatFee', () => {
    it('should format fee without byte size', () => {
      expect(formatFee(1000n)).toBe('1000 watts');
      expect(formatFee(100_000_000n)).toBe('1 BOLT');
    });
    
    it('should format fee with byte size', () => {
      expect(formatFee(1000n, 250)).toBe('1000 watts (4 watts/byte)');
      expect(formatFee(500n, 100)).toBe('500 watts (5 watts/byte)');
      expect(formatFee(100_000_000n, 250)).toBe('1 BOLT (400000 watts/byte)');
    });
    
    it('should handle zero byte size', () => {
      expect(formatFee(1000n, 0)).toBe('1000 watts');
    });
  });
});