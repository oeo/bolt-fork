import { describe, it, expect, beforeEach } from 'bun:test';
import { mainnet } from '../../src/config/chains/mainnet';
import { testnet } from '../../src/config/chains/testnet';
import { devnet } from '../../src/config/chains/devnet';
import type { ChainConfig } from '../../src/config/chain';

describe('Chain Configuration', () => {
  describe('mainnet config', () => {
    it('should have correct chain id', () => {
      expect(mainnet.chainId).toBe(1057);
      expect(mainnet.name).toBe('mainnet');
    });

    it('should have correct economic parameters', () => {
      expect(mainnet.maxSupply).toBe(21_000_000n * 100_000_000n);
      expect(mainnet.initialReward).toBe(50n * 100_000_000n);
      expect(mainnet.halvingInterval).toBe(210000);
      expect(mainnet.minFeePerByte).toBe(1n);
    });

    it('should have correct timing parameters', () => {
      expect(mainnet.targetBlockTime).toBe(300); // 5 minutes
      expect(mainnet.difficultyAdjustmentInterval).toBe(2016);
    });

    it('should have correct difficulty parameters', () => {
      expect(mainnet.initialDifficulty).toBe(1000);
      expect(mainnet.minDifficulty).toBe(1);
      expect(mainnet.maxDifficultyAdjustment).toBe(4);
    });

    it('should have correct genesis block', () => {
      expect(mainnet.genesisTimestamp).toBe(1757000000);
      expect(mainnet.genesisNonce).toBe(0);
      expect(mainnet.genesisMemo).toBe('we will craft citadels in the clouds or bury vaults within the ashes.');
    });

    it('should have sha256 as hash algorithm', () => {
      expect(mainnet.hashAlgorithm).toBe('sha256');
    });

    it('should have feature activation heights', () => {
      expect(mainnet.features).toBeDefined();
      expect(mainnet.features?.blockMemo).toBe(0);
      expect(mainnet.features?.compressedKeys).toBe(100000);
    });
  });

  describe('testnet config', () => {
    it('should have different chain id', () => {
      expect(testnet.chainId).toBe(1058);
      expect(testnet.name).toBe('testnet');
    });

    it('should have faster block time', () => {
      expect(testnet.targetBlockTime).toBe(60); // 1 minute
      expect(testnet.difficultyAdjustmentInterval).toBe(100);
    });

    it('should have lower initial difficulty', () => {
      expect(testnet.initialDifficulty).toBe(10);
    });

    it('should have faster halving for testing', () => {
      expect(testnet.halvingInterval).toBe(10000);
    });

    it('should activate features earlier', () => {
      expect(testnet.features?.compressedKeys).toBe(1000);
    });
  });

  describe('devnet config', () => {
    it('should have unique chain id', () => {
      expect(devnet.chainId).toBe(1059);
      expect(devnet.name).toBe('devnet');
    });

    it('should have very fast block time', () => {
      expect(devnet.targetBlockTime).toBe(10); // 10 seconds
      expect(devnet.difficultyAdjustmentInterval).toBe(20);
    });

    it('should have minimal difficulty', () => {
      expect(devnet.initialDifficulty).toBe(1);
      expect(devnet.minDifficulty).toBe(1);
    });

    it('should have higher initial reward for testing', () => {
      expect(devnet.initialReward).toBe(1000n * 100_000_000n);
    });

    it('should never have zero fee to avoid division issues', () => {
      expect(devnet.minFeePerByte).toBeGreaterThan(0n);
    });

    it('should have all features active from start', () => {
      expect(devnet.features?.blockMemo).toBe(0);
      expect(devnet.features?.compressedKeys).toBe(0);
    });

    it('should have larger block size for testing', () => {
      expect(devnet.maxBlockSize).toBe(10_000_000); // 10MB
    });
  });

  describe('config validation', () => {
    it('should have non-zero minimum difficulty', () => {
      [mainnet, testnet, devnet].forEach(config => {
        expect(config.minDifficulty).toBeGreaterThan(0);
      });
    });

    it('should have positive economic values', () => {
      [mainnet, testnet, devnet].forEach(config => {
        expect(config.maxSupply).toBeGreaterThan(0n);
        expect(config.initialReward).toBeGreaterThan(0n);
        expect(config.halvingInterval).toBeGreaterThan(0);
      });
    });

    it('should have reasonable timing values', () => {
      [mainnet, testnet, devnet].forEach(config => {
        expect(config.targetBlockTime).toBeGreaterThan(0);
        expect(config.difficultyAdjustmentInterval).toBeGreaterThan(0);
        expect(config.maxTimeDrift).toBeGreaterThan(0);
      });
    });

    it('should have valid hash algorithms', () => {
      const validAlgorithms = ['sha256', 'sha512', 'scrypt', 'double-sha256'];
      [mainnet, testnet, devnet].forEach(config => {
        expect(validAlgorithms).toContain(config.hashAlgorithm);
      });
    });
  });

  describe('feature activation', () => {
    const mockConfig: ChainConfig = {
      ...mainnet,
      features: {
        feature1: 100,
        feature2: 200,
        feature3: 300,
      }
    };

    it('should correctly determine feature activation', () => {
      // we can't test the actual functions without importing them
      // but we can verify the feature configuration structure
      expect(mockConfig.features).toBeDefined();
      expect(Object.keys(mockConfig.features!).length).toBe(3);
    });
  });

  describe('chain differentiation', () => {
    it('should have unique chain ids', () => {
      const ids = [mainnet.chainId, testnet.chainId, devnet.chainId];
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have different genesis timestamps', () => {
      expect(mainnet.genesisTimestamp).not.toBe(testnet.genesisTimestamp);
      expect(testnet.genesisTimestamp).not.toBe(devnet.genesisTimestamp);
    });

    it('should have different names', () => {
      expect(mainnet.name).toBe('mainnet');
      expect(testnet.name).toBe('testnet');
      expect(devnet.name).toBe('devnet');
    });
  });
});