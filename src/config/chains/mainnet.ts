import type { ChainConfig } from '../chain';

export const mainnet: ChainConfig = {
  // identity
  chainId: 1057,
  name: 'mainnet',
  startupEnabled: false,
  
  // timing
  targetBlockTime: 300,
  difficultyAdjustmentInterval: 2016,
  
  // economics
  maxSupply: 21_000_000n * 100_000_000n,  // 21M BOLT in watts
  initialReward: 50n * 100_000_000n,       // 50 BOLT in watts  
  halvingInterval: 210000,
  minFeePerByte: 1n,                       // 1 watt per byte
  
  // difficulty
  initialDifficulty: 1000,
  minDifficulty: 1,
  maxDifficultyAdjustment: 4,
  
  // limits
  maxBlockSize: 1_000_000,                 // 1MB
  maxTimeDrift: 7200,                      // 2 hours
  medianTimeBlocks: 11,
  
  // hashing
  hashAlgorithm: 'sha256',
  
  // addressing
  addressPrefix: 0x00,  // addresses start with '1'
  
  // genesis
  genesisTimestamp: 1_757_000_000_000,
  genesisNonce: 61,
  genesisMemo: 'we will craft citadels in the clouds or bury vaults within the ashes.',
};
