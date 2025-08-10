import { Block } from '../types';
import { BlockClass } from './block';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export interface Fork {
  tipHash: string;
  tipHeight: number;
  blocks: Block[];
  cumulativeDifficulty: bigint;
  lastSeen: number;
  peerId?: string;
}

export interface ForkComparison {
  ourWork: bigint;
  theirWork: bigint;
  commonAncestorHeight: number;
  shouldReorganize: boolean;
}

/**
 * manages competing blockchain forks
 */
export class ForkManager {
  private forks: Map<string, Fork> = new Map();
  private orphanBlocks: Map<string, Block> = new Map();
  private maxForks: number = 10;
  private maxOrphans: number = 100;
  private orphanTimeout: number = 300000; // 5 minutes
  
  constructor() {
    // cleanup old orphans periodically
    setInterval(() => this.cleanupOrphans(), 60000);
  }
  
  /**
   * add a fork to track
   */
  addFork(tipBlock: Block, cumulativeDifficulty: bigint, peerId?: string): void {
    const fork: Fork = {
      tipHash: tipBlock.hash,
      tipHeight: tipBlock.index,
      blocks: [tipBlock],
      cumulativeDifficulty,
      lastSeen: Date.now(),
      peerId
    };
    
    this.forks.set(tipBlock.hash, fork);
    logger.info(`Tracking new fork at height ${tipBlock.index} with cumulative difficulty ${cumulativeDifficulty}`);
    
    // limit number of tracked forks
    if (this.forks.size > this.maxForks) {
      this.pruneOldestFork();
    }
  }
  
  /**
   * update an existing fork with a new block
   */
  updateFork(previousHash: string, newBlock: Block, peerId?: string): Fork | null {
    const fork = this.findForkByTip(previousHash);
    if (!fork) {
      // check if this extends an orphan
      const orphan = this.orphanBlocks.get(previousHash);
      if (orphan) {
        // create new fork from orphan chain
        this.addFork(newBlock, BigInt(newBlock.difficulty), peerId);
        return this.forks.get(newBlock.hash) || null;
      }
      return null;
    }
    
    // update fork
    fork.blocks.push(newBlock);
    fork.tipHash = newBlock.hash;
    fork.tipHeight = newBlock.index;
    fork.cumulativeDifficulty += BigInt(newBlock.difficulty);
    fork.lastSeen = Date.now();
    if (peerId) fork.peerId = peerId;
    
    // update map key
    this.forks.delete(previousHash);
    this.forks.set(newBlock.hash, fork);
    
    logger.debug(`Updated fork to height ${newBlock.index}, cumulative difficulty: ${fork.cumulativeDifficulty}`);
    return fork;
  }
  
  /**
   * find fork by tip hash
   */
  findForkByTip(tipHash: string): Fork | undefined {
    return this.forks.get(tipHash);
  }
  
  /**
   * find fork that contains a specific block
   */
  findForkContaining(blockHash: string): Fork | undefined {
    for (const fork of this.forks.values()) {
      if (fork.blocks.some(b => b.hash === blockHash)) {
        return fork;
      }
    }
    return undefined;
  }
  
  /**
   * add orphan block (block without known parent)
   */
  addOrphan(block: Block): void {
    if (this.orphanBlocks.size >= this.maxOrphans) {
      // remove oldest orphan
      const oldest = Array.from(this.orphanBlocks.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) {
        this.orphanBlocks.delete(oldest[0]);
      }
    }
    
    this.orphanBlocks.set(block.hash, block);
    logger.debug(`Added orphan block ${block.hash} at height ${block.index}`);
  }
  
  /**
   * get orphan blocks that could extend a given block
   */
  getOrphansExtending(blockHash: string): Block[] {
    const orphans: Block[] = [];
    for (const orphan of this.orphanBlocks.values()) {
      if (orphan.previousHash === blockHash) {
        orphans.push(orphan);
      }
    }
    return orphans;
  }
  
  /**
   * compare our chain with a competing fork
   */
  compareFork(
    fork: Fork,
    ourHeight: number,
    ourCumulativeDifficulty: bigint,
    ourTipHash?: string
  ): ForkComparison {
    // find common ancestor (simplified - assumes fork started from our chain)
    const commonAncestorHeight = Math.min(
      fork.tipHeight - fork.blocks.length,
      ourHeight
    );
    
    // primary: higher cumulative difficulty wins
    let shouldReorganize = fork.cumulativeDifficulty > ourCumulativeDifficulty;
    
    // tie-breaker: if equal difficulty, use lexicographically lower hash
    if (fork.cumulativeDifficulty === ourCumulativeDifficulty && ourTipHash) {
      shouldReorganize = fork.tipHash < ourTipHash;
    }
    
    return {
      ourWork: ourCumulativeDifficulty,
      theirWork: fork.cumulativeDifficulty,
      commonAncestorHeight,
      shouldReorganize
    };
  }
  
  /**
   * get best fork by cumulative difficulty with deterministic tie-breaker
   */
  getBestFork(): Fork | undefined {
    let bestFork: Fork | undefined;
    let bestDifficulty = 0n;
    
    for (const fork of this.forks.values()) {
      // primary: higher cumulative difficulty wins
      if (fork.cumulativeDifficulty > bestDifficulty) {
        bestDifficulty = fork.cumulativeDifficulty;
        bestFork = fork;
      } else if (fork.cumulativeDifficulty === bestDifficulty && bestFork) {
        // tie-breaker: lexicographically lower hash wins
        if (fork.tipHash < bestFork.tipHash) {
          bestFork = fork;
        }
      }
    }
    
    return bestFork;
  }
  
  /**
   * remove a fork
   */
  removeFork(tipHash: string): void {
    this.forks.delete(tipHash);
  }
  
  /**
   * prune oldest fork
   */
  private pruneOldestFork(): void {
    let oldestTime = Date.now();
    let oldestHash = '';
    
    for (const [hash, fork] of this.forks.entries()) {
      if (fork.lastSeen < oldestTime) {
        oldestTime = fork.lastSeen;
        oldestHash = hash;
      }
    }
    
    if (oldestHash) {
      this.forks.delete(oldestHash);
      logger.debug(`Pruned old fork ${oldestHash}`);
    }
  }
  
  /**
   * cleanup old orphan blocks
   */
  private cleanupOrphans(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    for (const [hash, block] of this.orphanBlocks.entries()) {
      if (now - block.timestamp > this.orphanTimeout) {
        expired.push(hash);
      }
    }
    
    for (const hash of expired) {
      this.orphanBlocks.delete(hash);
    }
    
    if (expired.length > 0) {
      logger.debug(`Cleaned up ${expired.length} expired orphan blocks`);
    }
  }
  
  /**
   * get fork statistics
   */
  getStats(): {
    forksCount: number;
    orphansCount: number;
    bestForkHeight: number;
    bestForkDifficulty: string;
  } {
    const bestFork = this.getBestFork();
    return {
      forksCount: this.forks.size,
      orphansCount: this.orphanBlocks.size,
      bestForkHeight: bestFork?.tipHeight || 0,
      bestForkDifficulty: bestFork?.cumulativeDifficulty.toString() || '0'
    };
  }
  
  /**
   * clear all forks and orphans
   */
  clear(): void {
    this.forks.clear();
    this.orphanBlocks.clear();
  }
}