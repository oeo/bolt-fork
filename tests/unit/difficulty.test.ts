import { describe, it, expect } from 'bun:test';
import {
  calculateNewDifficulty,
  shouldAdjustDifficulty,
  getExpectedTime,
  getActualTime,
  getAverageBlockTime,
  getDifficultyAdjustment,
  validateBlockDifficulty,
  estimateTimeToAdjustment,
  calculateCumulativeDifficulty,
  calculateBlockWork,
  formatDifficulty,
  DEFAULT_DIFFICULTY_CONFIG,
  DifficultyConfig
} from '../../src/core/difficulty';
import { BlockClass } from '../../src/core/block';

describe('Difficulty Adjustment', () => {
  const testConfig: DifficultyConfig = {
    adjustmentInterval: 10,  // small for testing
    targetBlockTime: 60,      // 1 minute
    maxAdjustmentFactor: 4,
    minDifficulty: 1
  };
  
  describe('calculateNewDifficulty', () => {
    it('should increase difficulty when blocks are too fast', () => {
      const currentDifficulty = 100;
      const actualTime = 300;  // 5 minutes (too fast)
      const expectedTime = 600; // 10 minutes expected
      
      const newDifficulty = calculateNewDifficulty(
        currentDifficulty,
        actualTime,
        expectedTime,
        testConfig
      );
      
      expect(newDifficulty).toBe(200); // doubled
    });
    
    it('should decrease difficulty when blocks are too slow', () => {
      const currentDifficulty = 100;
      const actualTime = 1200; // 20 minutes (too slow)
      const expectedTime = 600; // 10 minutes expected
      
      const newDifficulty = calculateNewDifficulty(
        currentDifficulty,
        actualTime,
        expectedTime,
        testConfig
      );
      
      expect(newDifficulty).toBe(50); // halved
    });
    
    it('should cap increase at max adjustment factor', () => {
      const currentDifficulty = 100;
      const actualTime = 100;   // very fast
      const expectedTime = 600; // would be 6x increase
      
      const newDifficulty = calculateNewDifficulty(
        currentDifficulty,
        actualTime,
        expectedTime,
        testConfig
      );
      
      expect(newDifficulty).toBe(400); // capped at 4x
    });
    
    it('should cap decrease at 1/max adjustment factor', () => {
      const currentDifficulty = 100;
      const actualTime = 3000;  // very slow
      const expectedTime = 600; // would be 1/5 decrease
      
      const newDifficulty = calculateNewDifficulty(
        currentDifficulty,
        actualTime,
        expectedTime,
        testConfig
      );
      
      expect(newDifficulty).toBe(25); // capped at 1/4
    });
    
    it('should respect minimum difficulty', () => {
      const currentDifficulty = 2;
      const actualTime = 3000;
      const expectedTime = 600;
      
      const newDifficulty = calculateNewDifficulty(
        currentDifficulty,
        actualTime,
        expectedTime,
        testConfig
      );
      
      expect(newDifficulty).toBe(1); // minimum
    });
    
    it('should respect maximum difficulty if set', () => {
      const configWithMax: DifficultyConfig = {
        ...testConfig,
        maxDifficulty: 150
      };
      
      const currentDifficulty = 100;
      const actualTime = 300;
      const expectedTime = 600;
      
      const newDifficulty = calculateNewDifficulty(
        currentDifficulty,
        actualTime,
        expectedTime,
        configWithMax
      );
      
      expect(newDifficulty).toBe(150); // capped at max
    });
  });
  
  describe('shouldAdjustDifficulty', () => {
    it('should return true at adjustment interval', () => {
      expect(shouldAdjustDifficulty(11, testConfig)).toBe(true);
      expect(shouldAdjustDifficulty(21, testConfig)).toBe(true);
      expect(shouldAdjustDifficulty(31, testConfig)).toBe(true);
    });
    
    it('should return false between intervals', () => {
      expect(shouldAdjustDifficulty(5, testConfig)).toBe(false);
      expect(shouldAdjustDifficulty(15, testConfig)).toBe(false);
      expect(shouldAdjustDifficulty(25, testConfig)).toBe(false);
    });
    
    it('should return false for genesis block', () => {
      expect(shouldAdjustDifficulty(0, testConfig)).toBe(false);
    });
    
    it('should use default config', () => {
      expect(shouldAdjustDifficulty(2017)).toBe(true);
      expect(shouldAdjustDifficulty(2016)).toBe(false);
    });
  });
  
  describe('getExpectedTime', () => {
    it('should calculate expected time', () => {
      const blockCount = 10;
      const expected = getExpectedTime(blockCount, testConfig);
      expect(expected).toBe(600); // 10 blocks * 60 seconds
    });
    
    it('should use default config', () => {
      const blockCount = 2016;
      const expected = getExpectedTime(blockCount);
      expect(expected).toBe(604800); // 2016 * 300 seconds
    });
  });
  
  describe('getActualTime', () => {
    it('should calculate actual time between blocks', () => {
      const firstBlock = new BlockClass(
        0,
        1000000, // 1 second in milliseconds
        '',
        [],
        1,
        'test'
      );
      
      const lastBlock = new BlockClass(
        10,
        601000000, // 601 seconds later in milliseconds
        '',
        [],
        1,
        'test'
      );
      
      const actualTime = getActualTime(firstBlock, lastBlock);
      expect(actualTime).toBe(600000); // 600000 seconds
    });
  });
  
  describe('getAverageBlockTime', () => {
    it('should calculate average block time', () => {
      const blocks = [
        new BlockClass(0, 0, '', [], 1, 'test'),
        new BlockClass(1, 60000, '', [], 1, 'test'),     // 60s
        new BlockClass(2, 130000, '', [], 1, 'test'),    // 70s
        new BlockClass(3, 180000, '', [], 1, 'test'),    // 50s
        new BlockClass(4, 240000, '', [], 1, 'test')     // 60s
      ];
      
      const avgTime = getAverageBlockTime(blocks);
      expect(avgTime).toBe(60); // average 60 seconds
    });
    
    it('should return in milliseconds if requested', () => {
      const blocks = [
        new BlockClass(0, 0, '', [], 1, 'test'),
        new BlockClass(1, 60000, '', [], 1, 'test')
      ];
      
      const avgTime = getAverageBlockTime(blocks, false);
      expect(avgTime).toBe(60000); // milliseconds
    });
    
    it('should throw with less than 2 blocks', () => {
      const blocks = [new BlockClass(0, 0, '', [], 1, 'test')];
      
      expect(() => getAverageBlockTime(blocks)).toThrow();
    });
    
    it('should handle unsorted blocks', () => {
      const blocks = [
        new BlockClass(3, 180000, '', [], 1, 'test'),
        new BlockClass(1, 60000, '', [], 1, 'test'),
        new BlockClass(0, 0, '', [], 1, 'test'),
        new BlockClass(2, 120000, '', [], 1, 'test')
      ];
      
      const avgTime = getAverageBlockTime(blocks);
      expect(avgTime).toBe(60); // should sort and calculate correctly
    });
  });
  
  describe('getDifficultyAdjustment', () => {
    it('should return current difficulty when not at interval', async () => {
      const getBlock = async (height: number) => {
        if (height === 4) {
          return new BlockClass(4, Date.now(), '', [], 100, 'test');
        }
        return null;
      };
      
      const difficulty = await getDifficultyAdjustment(5, getBlock, testConfig);
      expect(difficulty).toBe(100);
    });
    
    it('should calculate new difficulty at interval', async () => {
      const blocks: Record<number, BlockClass> = {
        1: new BlockClass(1, 0, '', [], 100, 'test'),
        10: new BlockClass(10, 540000, '', [], 100, 'test')
      };
      
      const getBlock = async (height: number) => blocks[height] || null;
      
      const difficulty = await getDifficultyAdjustment(11, getBlock, testConfig);
      expect(difficulty).toBe(100);
    });
    
    it('should increase difficulty for fast blocks', async () => {
      const blocks: Record<number, BlockClass> = {
        1: new BlockClass(1, 0, '', [], 100, 'test'),
        10: new BlockClass(10, 300000, '', [], 100, 'test')
      };
      
      const getBlock = async (height: number) => blocks[height] || null;
      
      const difficulty = await getDifficultyAdjustment(11, getBlock, testConfig);
      expect(difficulty).toBe(180);
    });
  });
  
  describe('validateBlockDifficulty', () => {
    it('should validate correct difficulty', () => {
      const block = new BlockClass(10, Date.now(), '', [], 100, 'test');
      expect(validateBlockDifficulty(block, 100)).toBe(true);
    });
    
    it('should reject incorrect difficulty', () => {
      const block = new BlockClass(10, Date.now(), '', [], 100, 'test');
      expect(validateBlockDifficulty(block, 200)).toBe(false);
    });
  });
  
  describe('estimateTimeToAdjustment', () => {
    it('should estimate time to next adjustment', () => {
      const currentHeight = 5;
      const averageBlockTime = 60; // seconds
      
      const estimate = estimateTimeToAdjustment(currentHeight, averageBlockTime, testConfig);
      expect(estimate).toBe(360);
    });
    
    it('should handle being at adjustment boundary', () => {
      const currentHeight = 10;
      const averageBlockTime = 60;
      
      const estimate = estimateTimeToAdjustment(currentHeight, averageBlockTime, testConfig);
      expect(estimate).toBe(60);
    });
  });
  
  describe('calculateCumulativeDifficulty', () => {
    it('should sum exact block work', () => {
      const blocks = [
        new BlockClass(0, 0, '', [], 10, 'test'),
        new BlockClass(1, 0, '', [], 20, 'test'),
        new BlockClass(2, 0, '', [], 30, 'test')
      ];
      
      const cumulative = calculateCumulativeDifficulty(blocks);
      expect(cumulative).toBe(57n);
    });
    
    it('should handle empty array', () => {
      const cumulative = calculateCumulativeDifficulty([]);
      expect(cumulative).toBe(0n);
    });
  });

  describe('calculateBlockWork', () => {
    it('should derive work from the proof-of-work target', () => {
      expect(calculateBlockWork(1)).toBe(1n);
      expect(calculateBlockWork(2)).toBe(2n);
      expect(calculateBlockWork(3)).toBe(2n);
      expect(calculateBlockWork(100000)).toBe(99999n);
    });

    it('should reject invalid difficulty', () => {
      expect(() => calculateBlockWork(0)).toThrow('Invalid difficulty');
      expect(() => calculateBlockWork(1.5)).toThrow('Invalid difficulty');
    });
  });
  
  describe('formatDifficulty', () => {
    it('should format small numbers', () => {
      expect(formatDifficulty(999)).toBe('999');
    });
    
    it('should format thousands', () => {
      expect(formatDifficulty(1500)).toBe('1.50K');
      expect(formatDifficulty(999999)).toBe('1000.00K');
    });
    
    it('should format millions', () => {
      expect(formatDifficulty(1500000)).toBe('1.50M');
      expect(formatDifficulty(999999999)).toBe('1000.00M');
    });
    
    it('should format billions', () => {
      expect(formatDifficulty(1500000000)).toBe('1.50G');
    });
  });
});
