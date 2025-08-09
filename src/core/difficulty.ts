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
  // calculate adjustment ratio
  let adjustmentRatio = expectedTime / actualTime;
  
  // apply max adjustment limits (4x increase or 1/4 decrease)
  if (adjustmentRatio > config.maxAdjustmentFactor) {
    adjustmentRatio = config.maxAdjustmentFactor;
    logger.debug(`Difficulty adjustment capped at ${config.maxAdjustmentFactor}x increase`);
  } else if (adjustmentRatio < 1 / config.maxAdjustmentFactor) {
    adjustmentRatio = 1 / config.maxAdjustmentFactor;
    logger.debug(`Difficulty adjustment capped at ${config.maxAdjustmentFactor}x decrease`);
  }
  
  // calculate new difficulty
  let newDifficulty = currentDifficulty * adjustmentRatio;
  
  // apply minimum difficulty
  if (newDifficulty < config.minDifficulty) {
    newDifficulty = config.minDifficulty;
    logger.debug(`Difficulty floored at minimum: ${config.minDifficulty}`);
  }
  
  // apply maximum difficulty if set
  if (config.maxDifficulty && newDifficulty > config.maxDifficulty) {
    newDifficulty = config.maxDifficulty;
    logger.debug(`Difficulty capped at maximum: ${config.maxDifficulty}`);
  }
  
  // round to integer
  newDifficulty = Math.floor(newDifficulty);
  
  logger.info(`Difficulty adjusted: ${currentDifficulty} -> ${newDifficulty} (${adjustmentRatio.toFixed(2)}x)`);
  
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
  if (blockHeight === 0) return false;
  return blockHeight % config.adjustmentInterval === 0;
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
  firstBlock: Block | BlockClass,
  lastBlock: Block | BlockClass
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
  getBlockFn: (height: number) => Promise<Block | BlockClass | null>,
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
  const actualTime = getActualTime(firstBlock, lastBlock);
  const expectedTime = getExpectedTime(config.adjustmentInterval - 1, config);
  
  // calculate new difficulty
  const newDifficulty = calculateNewDifficulty(
    lastBlock.difficulty,
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
  const nextAdjustmentHeight = Math.ceil((currentHeight + 1) / config.adjustmentInterval) * config.adjustmentInterval;
  const blocksRemaining = nextAdjustmentHeight - currentHeight;
  
  return blocksRemaining * averageBlockTime;
}

/**
 * calculate cumulative difficulty for a chain
 */
export function calculateCumulativeDifficulty(blocks: (Block | BlockClass)[]): bigint {
  return blocks.reduce((total, block) => {
    return total + BigInt(block.difficulty);
  }, 0n);
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
  const nextAdjustmentHeight = Math.ceil((currentHeight + 1) / config.adjustmentInterval) * config.adjustmentInterval;
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