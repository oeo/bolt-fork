import { join } from 'path';

export interface ChainConfig {
  // identity
  chainId: number;                       // unique chain identifier (e.g., 1057 for bolt)
  name: string;                          // network name (mainnet, testnet, devnet)
  startupEnabled: boolean;

  // timing
  targetBlockTime: number;              // seconds between blocks
  difficultyAdjustmentInterval: number; // blocks between difficulty adjustments

  // economics
  maxSupply: bigint;                    // total supply in watts
  initialReward: bigint;                // initial block reward in watts
  halvingInterval: number;              // blocks between reward halvings
  minFeePerByte: bigint;                // minimum transaction fee in watts per byte

  // difficulty
  initialDifficulty: number;            // starting difficulty
  minDifficulty: number;                // difficulty floor
  maxDifficultyAdjustment: number;      // max adjustment factor (e.g., 4 = 4x or 0.25x)

  // limits
  maxBlockSize: number;                 // maximum block size in bytes
  maxTimeDrift: number;                 // max seconds a block can be in the future
  medianTimeBlocks: number;             // number of blocks for median time calculation

  // hashing
  hashAlgorithm: 'sha256' | 'sha512' | 'scrypt' | 'double-sha256'; // proof-of-work algorithm

  // addressing
  addressPrefix: number;                // version byte for addresses (affects first character)

  // genesis
  genesisTimestamp: number;             // unix timestamp of genesis block
  genesisNonce: number;                 // nonce of genesis block
  genesisMemo?: string;                 // optional message in genesis block

}

// load once at startup
const network = process.env.BOLT_NETWORK;
if (!network || !['mainnet', 'testnet', 'devnet'].includes(network)) {
  throw new Error('BOLT_NETWORK must be mainnet, testnet, or devnet');
}
const configModule = require(join(__dirname, 'chains', `${network}.ts`));
export const config: ChainConfig = configModule[network];
if (!config) throw new Error(`Missing chain configuration: ${network}`);

// get the configured hash algorithm for mining
export const miningHashAlgorithm = config.hashAlgorithm || 'sha256';


// get chain config
export function getChainConfig(): ChainConfig {
  return config;
}
