import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import { serialize } from '../utils/bigint';
import { BlockClass } from '../core/block';
import type { Block } from '../core/block';
import type { Blockchain } from '../core/blockchain';

const logger = getLogger(__filename);

interface OrphanBlock {
  block: Block;
  timestamp: number;
  receivedFrom: string;
}

export interface OrphanPoolConfig {
  blockchain: Blockchain;
  maxOrphans?: number;
  orphanExpiryTime?: number; // ms
  maxOrphanSize?: number; // bytes
}

/**
 * manages orphan blocks (blocks received before their parents)
 */
export class OrphanPool extends EventEmitter {
  private config: OrphanPoolConfig;
  private orphans: Map<string, OrphanBlock> = new Map();
  private orphansByPrevious: Map<string, Set<string>> = new Map();
  private totalSize: number = 0;
  private cleanupTimer: any;
  
  constructor(config: OrphanPoolConfig) {
    super();
    this.config = {
      maxOrphans: 100,
      orphanExpiryTime: 3600000, // 1 hour
      maxOrphanSize: 10 * 1024 * 1024, // 10 MB
      ...config
    };
  }
  
  /**
   * start orphan pool management
   */
  start(): void {
    logger.info('starting orphan pool');
    
    // periodic cleanup of expired orphans
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 60000); // every minute
  }
  
  /**
   * stop orphan pool management
   */
  stop(): void {
    logger.info('stopping orphan pool');
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    this.clear();
  }
  
  /**
   * add orphan block to pool
   */
  addOrphan(block: Block, receivedFrom: string): boolean {
    // check if we already have this orphan
    if (this.orphans.has(block.hash)) {
      logger.debug(`orphan ${block.hash.substring(0, 8)}... already in pool`);
      return false;
    }
    
    // estimate block size (rough approximation)
    const blockSize = serialize(block).length;
    
    // check size limits
    if (this.totalSize + blockSize > this.config.maxOrphanSize!) {
      this.evictOldest();
    }
    
    // check count limit
    if (this.orphans.size >= this.config.maxOrphans!) {
      this.evictOldest();
    }
    
    // add orphan
    const orphan: OrphanBlock = {
      block,
      timestamp: Date.now(),
      receivedFrom
    };
    
    this.orphans.set(block.hash, orphan);
    this.totalSize += blockSize;
    
    // index by previous hash for quick lookup
    let siblings = this.orphansByPrevious.get(block.previousHash);
    if (!siblings) {
      siblings = new Set();
      this.orphansByPrevious.set(block.previousHash, siblings);
    }
    siblings.add(block.hash);
    
    logger.info(`added orphan block ${block.index} (${block.hash.substring(0, 8)}...) from ${receivedFrom}`);
    logger.debug(`orphan pool size: ${this.orphans.size} blocks, ${this.totalSize} bytes`);
    
    this.emit('orphan:added', block);
    
    // check if we can request the parent
    this.requestParent(block.previousHash, receivedFrom);
    
    return true;
  }
  
  /**
   * check if orphans can be connected after new block
   */
  async processOrphansForParent(parentHash: string): Promise<Block[]> {
    const connected: Block[] = [];
    const orphanHashes = this.orphansByPrevious.get(parentHash);
    
    if (!orphanHashes || orphanHashes.size === 0) {
      return connected;
    }
    
    logger.info(`found ${orphanHashes.size} orphans for parent ${parentHash.substring(0, 8)}...`);
    
    for (const orphanHash of orphanHashes) {
      const orphan = this.orphans.get(orphanHash);
      if (!orphan) continue;
      
      try {
        // try to add the orphan block to the blockchain
        const added = await this.config.blockchain.addBlock(BlockClass.fromObject(orphan.block));
        if (added.valid) {
          logger.info(`connected orphan block ${orphan.block.index} to chain`);
          connected.push(orphan.block);
          
          // remove from orphan pool
          this.removeOrphan(orphanHash);
          
          // recursively process any orphans of this block
          const children = await this.processOrphansForParent(orphan.block.hash);
          connected.push(...children);
        }
      } catch (error) {
        logger.error(`failed to connect orphan ${orphanHash.substring(0, 8)}...:`, error);
        // keep in orphan pool for now
      }
    }
    
    return connected;
  }
  
  /**
   * remove orphan from pool
   */
  private removeOrphan(hash: string): void {
    const orphan = this.orphans.get(hash);
    if (!orphan) return;
    
    // remove from main map
    this.orphans.delete(hash);
    
    // remove from index
    const siblings = this.orphansByPrevious.get(orphan.block.previousHash);
    if (siblings) {
      siblings.delete(hash);
      if (siblings.size === 0) {
        this.orphansByPrevious.delete(orphan.block.previousHash);
      }
    }
    
    // update size
    const blockSize = serialize(orphan.block).length;
    this.totalSize = Math.max(0, this.totalSize - blockSize);
    
    logger.debug(`removed orphan ${hash.substring(0, 8)}... from pool`);
  }
  
  /**
   * evict oldest orphan
   */
  private evictOldest(): void {
    let oldest: OrphanBlock | null = null;
    let oldestHash: string | null = null;
    
    for (const [hash, orphan] of this.orphans) {
      if (!oldest || orphan.timestamp < oldest.timestamp) {
        oldest = orphan;
        oldestHash = hash;
      }
    }
    
    if (oldestHash) {
      logger.debug(`evicting oldest orphan ${oldestHash.substring(0, 8)}...`);
      this.removeOrphan(oldestHash);
      this.emit('orphan:evicted', oldestHash);
    }
  }
  
  /**
   * cleanup expired orphans
   */
  private cleanupExpired(): void {
    const now = Date.now();
    const expiry = this.config.orphanExpiryTime!;
    const expired: string[] = [];
    
    for (const [hash, orphan] of this.orphans) {
      if (now - orphan.timestamp > expiry) {
        expired.push(hash);
      }
    }
    
    if (expired.length > 0) {
      logger.info(`removing ${expired.length} expired orphans`);
      for (const hash of expired) {
        this.removeOrphan(hash);
        this.emit('orphan:expired', hash);
      }
    }
  }
  
  /**
   * request parent block from peer
   */
  private async requestParent(parentHash: string, peerId: string): Promise<void> {
    // check if we already have the parent
    const parentBlock = await this.config.blockchain.getBlockByHash(parentHash);
    if (parentBlock) {
      return;
    }
    
    // check if parent is also an orphan
    if (this.orphans.has(parentHash)) {
      return;
    }
    
    logger.info(`requesting parent block ${parentHash.substring(0, 8)}... from ${peerId}`);
    this.emit('parent:needed', parentHash, peerId);
  }
  
  /**
   * get orphan by hash
   */
  getOrphan(hash: string): Block | null {
    const orphan = this.orphans.get(hash);
    return orphan?.block || null;
  }
  
  /**
   * check if block is orphaned
   */
  hasOrphan(hash: string): boolean {
    return this.orphans.has(hash);
  }
  
  /**
   * get all orphans waiting for a specific parent
   */
  getOrphansForParent(parentHash: string): Block[] {
    const orphanHashes = this.orphansByPrevious.get(parentHash);
    if (!orphanHashes) return [];
    
    const blocks: Block[] = [];
    for (const hash of orphanHashes) {
      const orphan = this.orphans.get(hash);
      if (orphan) {
        blocks.push(orphan.block);
      }
    }
    
    return blocks;
  }
  
  /**
   * clear all orphans
   */
  clear(): void {
    this.orphans.clear();
    this.orphansByPrevious.clear();
    this.totalSize = 0;
    logger.info('cleared orphan pool');
  }
  
  /**
   * get orphan pool statistics
   */
  getStats(): {
    orphanCount: number;
    totalSize: number;
    oldestAge: number | null;
    uniqueParents: number;
  } {
    let oldestAge: number | null = null;
    
    if (this.orphans.size > 0) {
      const now = Date.now();
      let oldestTimestamp = now;
      
      for (const orphan of this.orphans.values()) {
        if (orphan.timestamp < oldestTimestamp) {
          oldestTimestamp = orphan.timestamp;
        }
      }
      
      oldestAge = now - oldestTimestamp;
    }
    
    return {
      orphanCount: this.orphans.size,
      totalSize: this.totalSize,
      oldestAge,
      uniqueParents: this.orphansByPrevious.size
    };
  }
}
