import { LMDBManager } from './lmdb-manager';
import { Block } from '../core/block';
import { getLogger } from '../utils/logger';
import { serializeBigInt, deserializeBigInt } from '../utils/serialization';

const logger = getLogger(__filename);

interface BlockHeader {
  index: number;
  previousHash: string;
  timestamp: number;
  merkleRoot: string;
  difficulty: number;
  nonce: number;
  hash: string;
}

/**
 * lmdb-backed blockchain storage
 * handles blocks, headers, and indexes
 */
export class LMDBBlockchainStore {
  private lmdb: LMDBManager;
  
  // in-memory cache for recent blocks
  private recentBlocks: Map<number, Block> = new Map();
  private readonly cacheSize = 100;

  constructor(lmdb: LMDBManager) {
    this.lmdb = lmdb;
  }

  /**
   * add a new block to the chain
   */
  async addBlock(block: Block): Promise<void> {
    const serialized = this.serializeBlock(block);
    const header = this.extractHeader(block);
    
    await this.lmdb.transaction(() => {
      // store full block (convert index to buffer for key)
      const indexBuffer = Buffer.allocUnsafe(4);
      indexBuffer.writeUInt32BE(block.index, 0);
      this.lmdb.blocks.put(indexBuffer, serialized);
      
      // store block index (hash -> height, convert height to buffer)
      const heightBuffer = Buffer.allocUnsafe(4);
      heightBuffer.writeUInt32BE(block.index, 0);
      this.lmdb.blockIndex.put(
        Buffer.from(block.hash, 'hex'),
        heightBuffer
      );
      
      // store header separately for fast sync
      this.lmdb.blockHeaders.put(
        indexBuffer,
        this.serializeHeader(header)
      );
      
      // update metadata (convert number to string for storage)
      const currentHeight = this.lmdb.metadata.get('chainHeight');
      const currentHeightNum = currentHeight ? parseInt(currentHeight) : -1;
      if (block.index > currentHeightNum) {
        this.lmdb.metadata.put('chainHeight', block.index.toString());
        this.lmdb.metadata.put('chainTip', block.hash);
      }
    });
    
    // update cache
    this.updateCache(block);
    
    logger.debug(`block ${block.index} stored with hash ${block.hash}`);
  }

  /**
   * get a block by height
   */
  async getBlock(height: number): Promise<Block | null> {
    // check cache first
    if (this.recentBlocks.has(height)) {
      return this.recentBlocks.get(height)!;
    }
    
    // convert height to buffer for key
    const indexBuffer = Buffer.allocUnsafe(4);
    indexBuffer.writeUInt32BE(height, 0);
    
    const data = await this.lmdb.blocks.get(indexBuffer);
    if (!data) return null;
    
    const block = this.deserializeBlock(data);
    
    // add to cache if recent
    const currentHeight = await this.getHeight();
    if (currentHeight - height < this.cacheSize) {
      this.updateCache(block);
    }
    
    return block;
  }

  /**
   * get a block by hash
   */
  async getBlockByHash(hash: string): Promise<Block | null> {
    const heightBuffer = await this.lmdb.blockIndex.get(Buffer.from(hash, 'hex'));
    if (!heightBuffer) return null;
    
    const height = heightBuffer.readUInt32BE(0);
    return this.getBlock(height);
  }

  /**
   * check if a block exists
   */
  async hasBlock(hash: string): Promise<boolean> {
    const exists = await this.lmdb.blockIndex.get(Buffer.from(hash, 'hex'));
    return exists !== undefined;
  }

  /**
   * get the current chain height
   */
  async getHeight(): Promise<number> {
    const height = await this.lmdb.metadata.get('chainHeight');
    return height ? parseInt(height) : -1;
  }

  /**
   * get the latest block
   */
  async getLatestBlock(): Promise<Block | null> {
    const height = await this.getHeight();
    if (height < 0) return null;
    return this.getBlock(height);
  }

  /**
   * get a range of blocks [start, end] inclusive
   * @param start - first block (inclusive)
   * @param end - last block (inclusive)
   * @example getBlockRange(1, 3) returns blocks 1,2,3
   */
  async getBlockRange(start: number, end: number): Promise<Block[]> {
    const blocks: Block[] = [];
    
    // manually iterate from start to end (inclusive)
    for (let i = start; i <= end; i++) {
      const block = await this.getBlock(i);
      if (block) {
        blocks.push(block);
      }
    }
    
    return blocks;
  }

  /**
   * get headers for a range (for headers-first sync)
   */
  async getHeaders(start: number, count: number): Promise<BlockHeader[]> {
    const headers: BlockHeader[] = [];
    
    // convert numbers to buffer keys
    const startKey = Buffer.allocUnsafe(4);
    startKey.writeUInt32BE(start, 0);
    const endKey = Buffer.allocUnsafe(4);
    endKey.writeUInt32BE(start + count - 1, 0);
    
    for await (const { value } of this.lmdb.blockHeaders.getRange({
      start: startKey,
      end: endKey,
    })) {
      headers.push(this.deserializeHeader(value));
    }
    
    return headers;
  }

  /**
   * remove blocks above a certain height (for reorg)
   */
  async removeBlocksAbove(height: number): Promise<void> {
    await this.lmdb.transaction(() => {
      // get all blocks to remove
      const blocksToRemove: Block[] = [];
      
      // convert height to buffer key
      const startKey = Buffer.allocUnsafe(4);
      startKey.writeUInt32BE(height + 1, 0);
      
      for (const { key, value } of this.lmdb.blocks.getRange({
        start: startKey,
      })) {
        blocksToRemove.push(this.deserializeBlock(value));
      }
      
      // remove blocks and indexes
      for (const block of blocksToRemove) {
        const indexBuffer = Buffer.allocUnsafe(4);
        indexBuffer.writeUInt32BE(block.index, 0);
        
        this.lmdb.blocks.remove(indexBuffer);
        this.lmdb.blockIndex.remove(Buffer.from(block.hash, 'hex'));
        this.lmdb.blockHeaders.remove(indexBuffer);
        
        // remove from cache
        this.recentBlocks.delete(block.index);
      }
      
      // update metadata
      if (blocksToRemove.length > 0) {
        this.lmdb.metadata.put('chainHeight', height.toString());
        // note: can't call getBlock inside transaction, will handle after
      }
    });
    
    logger.info(`removed ${await this.getHeight() - height} blocks above height ${height}`);
  }

  /**
   * get blockchain statistics
   */
  async getStats(): Promise<any> {
    const height = await this.getHeight();
    const blockCount = await this.lmdb.blocks.getCount();
    const indexCount = await this.lmdb.blockIndex.getCount();
    
    return {
      height,
      blockCount,
      indexCount,
      cacheSize: this.recentBlocks.size,
      tip: await this.lmdb.metadata.get('chainTip'),
    };
  }

  // serialization helpers
  
  private serializeBlock(block: Block): Buffer {
    const json = JSON.stringify({
      ...block,
      coinbaseAmount: block.coinbaseAmount ? serializeBigInt(block.coinbaseAmount) : undefined,
      transactions: block.transactions.map(tx => ({
        ...tx,
        amount: serializeBigInt(tx.amount),
        fee: serializeBigInt(tx.fee),
      })),
    });
    return Buffer.from(json);
  }

  private deserializeBlock(data: Buffer): Block {
    const json = JSON.parse(data.toString());
    return {
      ...json,
      coinbaseAmount: json.coinbaseAmount ? deserializeBigInt(json.coinbaseAmount) : undefined,
      transactions: json.transactions.map((tx: any) => ({
        ...tx,
        amount: deserializeBigInt(tx.amount),
        fee: deserializeBigInt(tx.fee),
      })),
    };
  }

  private extractHeader(block: Block): BlockHeader {
    return {
      index: block.index,
      previousHash: block.previousHash,
      timestamp: block.timestamp,
      merkleRoot: block.merkleRoot,
      difficulty: block.difficulty,
      nonce: block.nonce,
      hash: block.hash,
    };
  }

  private serializeHeader(header: BlockHeader): Buffer {
    return Buffer.from(JSON.stringify(header));
  }

  private deserializeHeader(data: Buffer): BlockHeader {
    return JSON.parse(data.toString());
  }

  private updateCache(block: Block): void {
    // add to cache
    this.recentBlocks.set(block.index, block);
    
    // remove oldest if cache is full
    if (this.recentBlocks.size > this.cacheSize) {
      const oldestHeight = Math.min(...this.recentBlocks.keys());
      this.recentBlocks.delete(oldestHeight);
    }
  }
}