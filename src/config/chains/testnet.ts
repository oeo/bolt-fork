import type { ChainConfig } from '../chain';
import { GENESIS_SLOGAN } from '../../constants';

export const testnet: ChainConfig = {
  // identity
  chainId: 1058,
  name: 'testnet',
  startupEnabled: true,
  
  // timing
  targetBlockTime: 60,                     // 1 minute blocks for faster testing
  difficultyAdjustmentInterval: 60,
  
  // economics
  maxSupply: 21_000_000n * 100_000_000n,  // same as mainnet
  initialReward: 50n * 100_000_000n,       // same as mainnet
  halvingInterval: 210000,
  minFeePerByte: 1n,
  
  // difficulty
  initialDifficulty: 60_000_000,
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
  genesisTimestamp: 1_700_000_000_000,
  genesisNonce: 138081769,
  genesisMemo: `bolt testnet genesis\n${GENESIS_SLOGAN}`,
};
