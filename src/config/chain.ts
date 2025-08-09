import { readFileSync } from 'fs';
import { join } from 'path';
import { hash } from '../crypto/hash';

export interface ChainConfig {
  // identity
  chainId: number;                       // unique chain identifier (e.g., 1057 for bolt)
  name: string;                          // network name (mainnet, testnet, devnet)

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

  // feature activation heights
  features?: Record<string, number>;    // features and their activation block heights
}

// load once at startup
const network = process.env.BOLT_NETWORK || 'mainnet';
const configModule = require(join(__dirname, 'chains', `${network}.ts`));
export const config: ChainConfig = configModule[network] || configModule.default;

// helper function to calculate chain version hash from any config
export function calculateChainVersionHash(chainConfig: ChainConfig): string {
  const configString = JSON.stringify(chainConfig, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
  return hash(configString, 'sha256');
}

// calculate chain hash once for the global config
export const chainVersionHash = calculateChainVersionHash(config);

// get the configured hash algorithm for mining
export const miningHashAlgorithm = config.hashAlgorithm || 'sha256';

// simple feature check
export function isFeatureActive(feature: string, height: number): boolean {
  const activation = config.features?.[feature];
  return activation !== undefined && height >= activation;
}

// get all active features at a given height
export function getActiveFeatures(height: number): string[] {
  if (!config.features) return [];

  return Object.entries(config.features)
    .filter(([_, activationHeight]) => height >= activationHeight)
    .map(([feature]) => feature);
}
