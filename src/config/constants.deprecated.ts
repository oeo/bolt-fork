// currency and blockchain constants for bolt
// all amounts are stored internally as watts (smallest unit)
// 1 BOLT = 100,000,000 watts

// helper to parse bigint from env with fallback
function getEnvBigInt(key: string, defaultValue: bigint): bigint {
  const value = process.env[key];
  if (!value) return defaultValue;
  try {
    return BigInt(value);
  } catch {
    console.warn(`Invalid ${key} value: ${value}, using default: ${defaultValue}`);
    return defaultValue;
  }
}

// helper to parse number from env with fallback
function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(`Invalid ${key} value: ${value}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

export const BOLT_CONFIG = {
  // currency definition
  name: "bolt",
  symbol: "BOLT",
  decimals: 8,
  subunit: "watt",
  subunitSymbol: "W",
  subunitsPerUnit: 100_000_000n, // 1 BOLT = 100 million watts

  // genesis block configuration
  genesis: {
    message: process.env.GENESIS_MESSAGE ||
      "we will craft citadels in the clouds or bury vaults within the ashes.",
    timestamp: getEnvNumber('GENESIS_TIMESTAMP', 1703001600000), // december 19, 2023
    difficulty: getEnvNumber('GENESIS_DIFFICULTY', 1),
    nonce: 0,
    previousHash: "0000000000000000000000000000000000000000000000000000000000000000"
  },

  // economic parameters (all in watts)
  economics: {
    initialReward: getEnvBigInt('INITIAL_REWARD', 50n * 100_000_000n), // 50 BOLT = 5 billion watts
    halvingInterval: getEnvNumber('HALVING_INTERVAL', 210_000), // halve every 210,000 blocks
    maxSupply: getEnvBigInt('MAX_SUPPLY', 21_000_000n * 100_000_000n), // 21M BOLT = 2.1 quadrillion watts
  },

  // consensus parameters
  consensus: {
    targetBlockTime: getEnvNumber('TARGET_BLOCK_TIME', 300), // 5 minutes in seconds
    difficultyAdjustmentInterval: getEnvNumber('DIFFICULTY_ADJUSTMENT_INTERVAL', 2016), // ~1 week
    maxAdjustmentFactor: getEnvNumber('MAX_ADJUSTMENT_FACTOR', 4), // max 4x increase or 1/4 decrease
    minDifficulty: getEnvNumber('MIN_DIFFICULTY', 1), // minimum network difficulty
  },

  // transaction limits (fees in watts)
  transactions: {
    minFeePerByte: getEnvBigInt('MIN_FEE_PER_BYTE', 1n), // 1 watt per byte minimum
    maxSize: getEnvNumber('MAX_TX_SIZE', 100_000), // 100KB max transaction size
    maxBlockSize: getEnvNumber('MAX_BLOCK_SIZE', 1_000_000), // 1MB max block size
  },

  // network prefixes for addresses
  addressPrefixes: {
    mainnet: 0x00,
    testnet: 0x6f,
    local: 0xef,
  }
} as const;

// export commonly used values as separate constants
export const WATTS_PER_BOLT = BOLT_CONFIG.subunitsPerUnit;
export const INITIAL_REWARD = BOLT_CONFIG.economics.initialReward;
export const HALVING_INTERVAL = BOLT_CONFIG.economics.halvingInterval;
export const MAX_SUPPLY = BOLT_CONFIG.economics.maxSupply;
export const TARGET_BLOCK_TIME = BOLT_CONFIG.consensus.targetBlockTime;
export const DIFFICULTY_ADJUSTMENT_INTERVAL = BOLT_CONFIG.consensus.difficultyAdjustmentInterval;

