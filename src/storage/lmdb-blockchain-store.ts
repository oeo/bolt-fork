import { LMDBManager } from './lmdb-manager';
import type { Block } from '../types';
import { getLogger } from '../utils/logger';
import { serializeBigInt, deserializeBigInt } from '../utils/serialization';

const logger = getLogger(__filename);

interface BlockHeader {
  index: number;
  previousHash: string;
  timestamp: number;
  merkleRoot: string;
  stateRoot: string;
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
    
    this.lmdb.transactionSync(() => {
      this.writeBlock(block, serialized, header);
    });
    
    // update cache
    this.updateCache(block);
    
    logger.debug(`block ${block.index} stored with hash ${block.hash}`);
  }

  writeBlock(block: Block, serialized = this.serializeBlock(block), header = this.extractHeader(block)): void {
      // store full block (convert index to buffer for key)
      const indexBuffer = Buffer.allocUnsafe(4);
      indexBuffer.writeUInt32BE(block.index, 0);
      this.lmdb.blocks.putSync(indexBuffer, serialized);
      
      // store block index (hash -> height, convert height to buffer)
      const heightBuffer = Buffer.allocUnsafe(4);
      heightBuffer.writeUInt32BE(block.index, 0);
      this.lmdb.blockIndex.putSync(
        Buffer.from(block.hash, 'hex'),
        heightBuffer
      );
      
      // store header separately for fast sync
      this.lmdb.blockHeaders.putSync(
        indexBuffer,
        this.serializeHeader(header)
      );
      
      // update metadata (convert number to string for storage)
      const currentHeight = this.lmdb.metadata.get('chainHeight');
      const currentHeightNum = currentHeight ? parseInt(currentHeight) : -1;
      if (block.index > currentHeightNum) {
        this.lmdb.metadata.putSync('chainHeight', block.index.toString());
        this.lmdb.metadata.putSync('chainTip', block.hash);
      }
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
    this.lmdb.transactionSync(() => {
      this.writeRemoveBlocksAbove(height);
    });
    this.clearCache();
    
    logger.info(`removed ${await this.getHeight() - height} blocks above height ${height}`);
  }

  writeRemoveBlocksAbove(height: number): void {
    const blocksToRemove: Block[] = [];
    const startKey = Buffer.allocUnsafe(4);
    startKey.writeUInt32BE(height + 1, 0);

    for (const { value } of this.lmdb.blocks.getRange({ start: startKey })) {
      blocksToRemove.push(this.deserializeBlock(value));
    }

    for (const block of blocksToRemove) {
      const indexBuffer = Buffer.allocUnsafe(4);
      indexBuffer.writeUInt32BE(block.index, 0);
      this.lmdb.blocks.removeSync(indexBuffer);
      this.lmdb.blockIndex.removeSync(Buffer.from(block.hash, 'hex'));
      this.lmdb.blockHeaders.removeSync(indexBuffer);
    }

    this.lmdb.metadata.putSync('chainHeight', height.toString());
    if (height < 0) {
      this.lmdb.metadata.removeSync('chainTip');
      return;
    }
    const tipKey = Buffer.allocUnsafe(4);
    tipKey.writeUInt32BE(height, 0);
    const tipData = this.lmdb.blocks.get(tipKey);
    if (tipData) {
      this.lmdb.metadata.putSync('chainTip', this.deserializeBlock(tipData).hash);
    } else {
      this.lmdb.metadata.removeSync('chainTip');
    }
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
      transactions: block.transactions.map(tx => ({
        ...tx,
        amount: serializeBigInt(tx.amount),
        fee: serializeBigInt(tx.fee),
      })),
    }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    return Buffer.from(json);
  }

  private deserializeBlock(data: Buffer): Block {
    const json = JSON.parse(data.toString());
    return {
      ...json,
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
      stateRoot: block.stateRoot,
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

  readBlock(height: number): Block | null {
    const key = Buffer.allocUnsafe(4);
    key.writeUInt32BE(height, 0);
    const data = this.lmdb.blocks.get(key);
    return data ? this.deserializeBlock(data) : null;
  }

  clearCache(): void {
    this.recentBlocks.clear();
  }
}
