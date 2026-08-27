import type { ChainConfig } from '../chain';

export const devnet: ChainConfig = {
  // identity
  chainId: 1059,
  name: 'devnet',
  startupEnabled: true,
  
  // timing
  targetBlockTime: 10,                     // 10 second blocks for rapid development
  difficultyAdjustmentInterval: 20,        // adjust every 20 blocks
  
  // economics
  maxSupply: 21_000_000n * 100_000_000n,
  initialReward: 1000n * 100_000_000n,     // 1000 BOLT for easy testing
  halvingInterval: 1000,                   // very fast halving
  minFeePerByte: 1n,                       // minimum 1 watt to avoid zero fee issues
  
  // difficulty
  initialDifficulty: 1,                    // minimal difficulty
  minDifficulty: 1,                        // never go below 1
  maxDifficultyAdjustment: 100,            // allow rapid adjustments
  
  // limits
  maxBlockSize: 10_000_000,                // 10MB for testing large blocks
  maxTimeDrift: 60,                        // 1 minute
  medianTimeBlocks: 5,
  
  // hashing
  hashAlgorithm: 'sha256',
  
  // addressing
  addressPrefix: 0xef,  // custom prefix for local development
  
  // genesis
  genesisTimestamp: 1_700_000_001_000,
  genesisNonce: 0,
  genesisMemo: 'bolt devnet - local development',
};
