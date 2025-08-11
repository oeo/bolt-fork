import type { ChainConfig } from '../chain';

export const testnet: ChainConfig = {
  // identity
  chainId: 1058,
  name: 'testnet',
  
  // timing
  targetBlockTime: 60,                     // 1 minute blocks for faster testing
  difficultyAdjustmentInterval: 100,       // adjust every 100 blocks
  
  // economics
  maxSupply: 21_000_000n * 100_000_000n,  // same as mainnet
  initialReward: 50n * 100_000_000n,       // same as mainnet
  halvingInterval: 10000,                  // faster halving for testing
  minFeePerByte: 1n,
  
  // difficulty
  initialDifficulty: 100000,               // increased difficulty for more realistic mining
  minDifficulty: 1,
  maxDifficultyAdjustment: 4,
  
  // limits
  maxBlockSize: 1_000_000,
  maxTimeDrift: 600,                       // 10 minutes
  medianTimeBlocks: 11,
  
  // hashing
  hashAlgorithm: 'sha256',
  
  // addressing
  addressPrefix: 0x6f,  // addresses start with 'm' or 'n' (testnet)
  
  // genesis
  genesisTimestamp: 1700000000,
  genesisNonce: 0,
  genesisMemo: 'bolt testnet genesis',
  
  // features (activate earlier for testing)
  features: {
    blockMemo: 0,
    compressedKeys: 1000,
  }
};