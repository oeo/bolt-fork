import { Block } from '../types';
import { BlockClass } from './block';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

/**
 * difficulty adjustment parameters
 */
export interface DifficultyConfig {
  adjustmentInterval: number;  // blocks between adjustments (default: 2016)
  targetBlockTime: number;      // target time per block in seconds (default: 300)
  maxAdjustmentFactor: number;  // max increase per adjustment (default: 4)
  minDifficulty: number;        // minimum allowed difficulty (default: 1)
  maxDifficulty?: number;       // optional maximum difficulty
}

/**
 * default configuration (bitcoin-like)
 */
export const DEFAULT_DIFFICULTY_CONFIG: DifficultyConfig = {
  adjustmentInterval: 2016,     // ~2 weeks at 5 min blocks
  targetBlockTime: 300,          // 5 minutes
  maxAdjustmentFactor: 4,        // max 4x increase or 1/4 decrease
  minDifficulty: 1
};

/**
 * calculate new difficulty based on actual vs expected time
 */
export function calculateNewDifficulty(
  currentDifficulty: number,
  actualTime: number,
  expectedTime: number,
  config: DifficultyConfig = DEFAULT_DIFFICULTY_CONFIG
): number {
  if (![currentDifficulty, actualTime, expectedTime, config.maxAdjustmentFactor, config.minDifficulty]
    .every(Number.isSafeInteger) || currentDifficulty < 1 || actualTime < 0 || expectedTime < 1 ||
      config.maxAdjustmentFactor < 1 || config.minDifficulty < 1) {
    throw new Error('Invalid difficulty adjustment input');
  }
  const factor = BigInt(config.maxAdjustmentFactor);
  const expected = BigInt(expectedTime);
  const minimumSpan = (expected + factor - 1n) / factor;
  const maximumSpan = expected * factor;
  const actual = BigInt(actualTime);
  const clamped = actual < minimumSpan ? minimumSpan : actual > maximumSpan ? maximumSpan : actual;
  let next = BigInt(currentDifficulty) * expected / clamped;
  if (next < BigInt(config.minDifficulty)) next = BigInt(config.minDifficulty);
  if (config.maxDifficulty !== undefined && next > BigInt(config.maxDifficulty)) {
    next = BigInt(config.maxDifficulty);
  }
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Difficulty exceeds safe integer range');
  const newDifficulty = Number(next);
  logger.info(`Difficulty adjusted: ${currentDifficulty} -> ${newDifficulty}`);
  return newDifficulty;
}

/**
 * check if difficulty adjustment is needed at given height
 */
export function shouldAdjustDifficulty(
  blockHeight: number,
  config: DifficultyConfig = DEFAULT_DIFFICULTY_CONFIG
): boolean {
  // adjustment happens at interval boundaries (except genesis)
  return blockHeight > 1 && (blockHeight - 1) % config.adjustmentInterval === 0;
}

/**
 * get the expected time for a range of blocks
 */
export function getExpectedTime(
  blockCount: number,
  config: DifficultyConfig = DEFAULT_DIFFICULTY_CONFIG
): number {
  return blockCount * config.targetBlockTime;
}

/**
 * get actual time taken for a range of blocks
 */
export function getActualTime(
  firstBlock: Pick<Block, 'timestamp'>,
  lastBlock: Pick<Block, 'timestamp'>
): number {
  const actualTime = lastBlock.timestamp - firstBlock.timestamp;
  
  // convert milliseconds to seconds
  return Math.floor(actualTime / 1000);
}

/**
 * calculate average block time for a range
 */
export function getAverageBlockTime(
  blocks: (Block | BlockClass)[],
  inSeconds: boolean = true
): number {
  if (blocks.length < 2) {
    throw new Error('Need at least 2 blocks to calculate average time');
  }
  
  // sort by index to ensure correct order
  const sorted = [...blocks].sort((a, b) => a.index - b.index);
  
  const firstBlock = sorted[0];
  const lastBlock = sorted[sorted.length - 1];
  const totalTime = lastBlock.timestamp - firstBlock.timestamp;
  const blockCount = lastBlock.index - firstBlock.index;
  
  if (blockCount === 0) {
    throw new Error('Blocks must have different indices');
  }
  
  const avgTime = totalTime / blockCount;
  
  // convert to seconds if requested
  return inSeconds ? avgTime / 1000 : avgTime;
}

/**
 * get difficulty adjustment for a specific block height
 */
export async function getDifficultyAdjustment(
  blockHeight: number,
  getBlockFn: (height: number) => Promise<Pick<Block, 'timestamp' | 'difficulty'> | null>,
  config: DifficultyConfig = DEFAULT_DIFFICULTY_CONFIG
): Promise<number> {
  // check if adjustment is needed
  if (!shouldAdjustDifficulty(blockHeight, config)) {
    // return current difficulty (from previous block)
    const prevBlock = await getBlockFn(blockHeight - 1);
    if (!prevBlock) {
      throw new Error(`Cannot find block at height ${blockHeight - 1}`);
    }
    return prevBlock.difficulty;
  }
  
  // get the first and last blocks of the adjustment period
  const firstBlockHeight = blockHeight - config.adjustmentInterval;
  const lastBlockHeight = blockHeight - 1;
  
  const firstBlock = await getBlockFn(firstBlockHeight);
  const lastBlock = await getBlockFn(lastBlockHeight);
  
  if (!firstBlock || !lastBlock) {
    throw new Error('Cannot find blocks for difficulty adjustment');
  }
  
  // calculate actual vs expected time
  const actualTime = lastBlock.timestamp - firstBlock.timestamp;
  const expectedTime = getExpectedTime(config.adjustmentInterval - 1, config) * 1000;
  
  // calculate new difficulty
  const newDifficulty = calculateNewDifficulty(
    firstBlock.difficulty,
    actualTime,
    expectedTime,
    config
  );
  
  return newDifficulty;
}

/**
 * validate difficulty for a block
 */
export function validateBlockDifficulty(
  block: Block | BlockClass,
  expectedDifficulty: number
): boolean {
  return block.difficulty === expectedDifficulty;
}

/**
 * estimate time to next adjustment
 */
export function estimateTimeToAdjustment(
  currentHeight: number,
  averageBlockTime: number,
  config: DifficultyConfig = DEFAULT_DIFFICULTY_CONFIG
): number {
  const completedEpochs = Math.floor(Math.max(0, currentHeight - 1) / config.adjustmentInterval);
  const nextAdjustmentHeight = (completedEpochs + 1) * config.adjustmentInterval + 1;
  const blocksRemaining = nextAdjustmentHeight - currentHeight;
  
  return blocksRemaining * averageBlockTime;
}

/**
 * calculate cumulative difficulty for a chain
 */
export function calculateCumulativeDifficulty(blocks: (Block | BlockClass)[]): bigint {
  return blocks.reduce((total, block) => {
    return total + calculateBlockWork(block.difficulty);
  }, 0n);
}

export function calculateBlockWork(difficulty: number): bigint {
  if (!Number.isSafeInteger(difficulty) || difficulty < 1) {
    throw new Error(`Invalid difficulty: ${difficulty}`);
  }

  const hashSpace = 1n << 256n;
  const maxTarget = hashSpace - 1n;
  const target = maxTarget / BigInt(difficulty);
  return hashSpace / (target + 1n);
}

/**
 * format difficulty for display
 */
export function formatDifficulty(difficulty: number): string {
  if (difficulty < 1000) {
    return difficulty.toString();
  } else if (difficulty < 1000000) {
    return `${(difficulty / 1000).toFixed(2)}K`;
  } else if (difficulty < 1000000000) {
    return `${(difficulty / 1000000).toFixed(2)}M`;
  } else {
    return `${(difficulty / 1000000000).toFixed(2)}G`;
  }
}

/**
 * get difficulty statistics
 */
export interface DifficultyStats {
  currentDifficulty: number;
  blocksUntilAdjustment: number;
  estimatedTimeToAdjustment: number;
  lastAdjustmentRatio?: number;
  averageBlockTime: number;
  targetBlockTime: number;
}

export async function getDifficultyStats(
  currentHeight: number,
  currentDifficulty: number,
  recentBlocks: (Block | BlockClass)[],
  config: DifficultyConfig = DEFAULT_DIFFICULTY_CONFIG
): Promise<DifficultyStats> {
  const averageBlockTime = getAverageBlockTime(recentBlocks);
  const completedEpochs = Math.floor(Math.max(0, currentHeight - 1) / config.adjustmentInterval);
  const nextAdjustmentHeight = (completedEpochs + 1) * config.adjustmentInterval + 1;
  const blocksUntilAdjustment = nextAdjustmentHeight - currentHeight;
  const estimatedTimeToAdjustment = estimateTimeToAdjustment(currentHeight, averageBlockTime, config);
  
  return {
    currentDifficulty,
    blocksUntilAdjustment,
    estimatedTimeToAdjustment,
    averageBlockTime,
    targetBlockTime: config.targetBlockTime
  };
}
