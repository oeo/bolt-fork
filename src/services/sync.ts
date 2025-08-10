import { EventEmitter } from 'events';
import { Blockchain } from '../core/blockchain';
import { PeerManager } from '../network/peer-manager';
import { BlockClass } from '../core/block';
import { getLogger } from '../utils/logger';

const logger = getLogger(__filename);

export interface SyncServiceConfig {
  blockchain: Blockchain;
  peerManager: PeerManager;
  syncInterval?: number; // milliseconds
  maxBlocksPerSync?: number;
}

/**
 * service for synchronizing blockchain with peers
 */
export class SyncService extends EventEmitter {
  private config: SyncServiceConfig;
  private syncing: boolean = false;
  private syncTimer?: NodeJS.Timeout;
  private started: boolean = false;
  
  constructor(config: SyncServiceConfig) {
    super();
    this.config = {
      syncInterval: 10000, // 10 seconds
      maxBlocksPerSync: 100,
      ...config
    };
  }
  
  /**
   * start the sync service
   */
  start(): void {
    if (this.started) {
      logger.warn('Sync service already started');
      return;
    }
    
    this.started = true;
    logger.info('Sync service started');
    
    // start periodic sync
    this.scheduleSyncCheck();
  }
  
  /**
   * stop the sync service
   */
  stop(): void {
    if (!this.started) {
      return;
    }
    
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
    
    this.started = false;
    logger.info('Sync service stopped');
  }
  
  /**
   * schedule next sync check
   */
  private scheduleSyncCheck(): void {
    if (!this.started) {
      return;
    }
    
    this.syncTimer = setTimeout(async () => {
      await this.checkAndSync();
      this.scheduleSyncCheck();
    }, this.config.syncInterval);
  }
  
  /**
   * check if sync is needed and perform it
   */
  private async checkAndSync(): Promise<void> {
    logger.debug('CheckAndSync called');
    
    if (this.syncing) {
      logger.debug('Sync already in progress, skipping');
      return;
    }
    
    try {
      // get best peer
      const bestPeer = this.config.peerManager.getBestPeer();
      if (!bestPeer) {
        logger.debug('No peers available for sync');
        return;
      }
      
      logger.info(`Best peer for sync: ${bestPeer.nodeId} with cumulative difficulty: ${bestPeer.cumulativeDifficulty}`);
      
      // update peer status to get latest block height and cumulative difficulty
      let peerInfo: any;
      try {
        peerInfo = await this.config.peerManager.getBlockchainInfo(bestPeer);
        logger.debug(`Peer ${bestPeer.nodeId} blockchain info: height=${peerInfo.height}, cumulative=${peerInfo.cumulativeDifficulty}`);
      } catch (error: any) {
        logger.debug(`Failed to update peer status: ${error.message}`);
        return; // can't sync without peer info
      }
      
      // check if we need to sync
      const ourHeight = await this.config.blockchain.getHeight();
      const peerHeight = peerInfo.height || 0;
      const ourCumulativeDifficulty = await this.config.blockchain.getCumulativeDifficulty();
      // remove 'n' suffix if present (BigInt notation)
      const peerDiffStr = (peerInfo.cumulativeDifficulty || '0').toString().replace(/n$/, '');
      const peerCumulativeDifficulty = BigInt(peerDiffStr);
      
      // sync decision based on cumulative difficulty (proof-of-work)
      if (peerCumulativeDifficulty < ourCumulativeDifficulty) {
        logger.debug(`No sync needed (our work: ${ourCumulativeDifficulty}, peer: ${peerCumulativeDifficulty})`);
        return;
      }
      
      // if equal difficulty, use deterministic tie-breaker
      if (peerCumulativeDifficulty === ourCumulativeDifficulty) {
        const ourLatest = await this.config.blockchain.getLatestBlock();
        
        // if at same height, compare block hashes
        if (peerHeight === ourHeight) {
          const peerBlocks = await this.config.peerManager.requestBlocks(peer, peerHeight);
          
          if (peerBlocks.length > 0 && ourLatest) {
            const peerLatest = peerBlocks[0];
            if (peerLatest.hash === ourLatest.hash) {
              logger.debug('Chains are in sync (same tip hash)');
              return;
            }
            
            // different tips with same cumulative difficulty - use hash as tiebreaker
            // lexicographically lower hash wins (deterministic across all nodes)
            if (peerLatest.hash < ourLatest.hash) {
              logger.info(`Tie-breaker: Peer's hash ${peerLatest.hash} < our hash ${ourLatest.hash}, switching chains`);
              await this.fetchCompleteChain(peer);
              return;
            } else {
              logger.debug(`Tie-breaker: Our hash ${ourLatest.hash} <= peer's hash ${peerLatest.hash}, keeping our chain`);
              return;
            }
          }
        } else if (peerHeight > ourHeight) {
          // peer has more blocks with same cumulative difficulty (shouldn't happen with proper difficulty)
          // but if it does, they have more proof of work
          logger.info(`Peer has more blocks (${peerHeight} > ${ourHeight}) with same cumulative difficulty, fetching their chain`);
          await this.fetchCompleteChain(peer);
          return;
        }
        
        logger.debug('We have the canonical chain with equal difficulty');
        return;
      }
      
      // peer has more cumulative work, we should sync
      logger.info(`Peer has more cumulative work: ${peerCumulativeDifficulty} > ${ourCumulativeDifficulty}`);
      
      // if peer has lower height but more work, we need reorganization
      if (peerHeight < ourHeight) {
        logger.warn(`Peer has lower height (${peerHeight}) but more work - reorganization needed`);
        // the sync process will handle fetching blocks and triggering reorg
      }
      
      logger.info(`Starting sync from ${ourHeight} to ${peerHeight} with peer ${bestPeer.nodeId}`);
      this.syncing = true;
      this.emit('syncStarted', { from: ourHeight, to: peerHeight, peer: bestPeer.nodeId });
      
      // sync blocks
      await this.syncBlocks(bestPeer, ourHeight + 1, peerHeight);
      
      logger.info(`Sync completed to height ${await this.config.blockchain.getHeight()}`);
      this.emit('syncCompleted', { height: await this.config.blockchain.getHeight() });
      
    } catch (error: any) {
      logger.error('Sync failed:', error.message);
      this.emit('syncFailed', { error: error.message });
    } finally {
      this.syncing = false;
    }
  }
  
  /**
   * sync blocks from a peer
   */
  private async syncBlocks(peer: any, fromHeight: number, toHeight: number): Promise<void> {
    let currentHeight = fromHeight;
    
    while (currentHeight <= toHeight && this.started) {
      try {
        // request blocks from peer
        const blocks = await this.config.peerManager.requestBlocks(peer, currentHeight);
        
        if (blocks.length === 0) {
          logger.warn(`No blocks received from ${peer.nodeId} at height ${currentHeight}`);
          break;
        }
        
        // add blocks to blockchain
        for (const blockData of blocks) {
          const block = BlockClass.fromObject(blockData);
          const result = await this.config.blockchain.addBlock(block);
          
          if (!result.valid) {
            // if it's a previous hash mismatch, we're on different chains
            if (result.error?.includes('Invalid previous hash')) {
              logger.warn(`Block ${block.index} has different previous hash - fetching full chain from peer`);
              
              // fetch the complete chain from genesis
              await this.fetchCompleteChain(peer);
              return; // exit sync loop, chain has been replaced
            }
            
            logger.error(`Failed to add block ${block.index}: ${result.error}`);
            // try different peer
            throw new Error(`Block validation failed: ${result.error}`);
          }
          
          currentHeight = block.index + 1;
          logger.debug(`Added block ${block.index} from ${peer.nodeId}`);
          
          // emit progress
          this.emit('blockSynced', { height: block.index, total: toHeight });
        }
        
      } catch (error: any) {
        logger.error(`Failed to sync from ${peer.nodeId}:`, error.message);
        
        // try different peer
        const nextPeer = this.config.peerManager.getBestPeer();
        if (nextPeer && nextPeer.nodeId !== peer.nodeId) {
          logger.info(`Switching to peer ${nextPeer.nodeId} for sync`);
          peer = nextPeer;
        } else {
          throw error;
        }
      }
    }
  }
  
  /**
   * fetch complete chain from a peer and evaluate for reorganization
   */
  private async fetchCompleteChain(peer: any): Promise<void> {
    logger.info(`Fetching complete chain from peer ${peer.nodeId}`);
    
    try {
      // get peer's blockchain info
      const peerInfo = await this.config.peerManager.getBlockchainInfo(peer);
      const peerHeight = peerInfo.height;
      // remove 'n' suffix if present (BigInt notation)
      const peerDiffStr = (peerInfo.cumulativeDifficulty || '0').toString().replace(/n$/, '');
      const peerCumulativeDifficulty = BigInt(peerDiffStr);
      
      // check if peer's chain has more work
      const ourCumulativeDifficulty = await this.config.blockchain.getCumulativeDifficulty();
      
      if (peerCumulativeDifficulty <= ourCumulativeDifficulty) {
        logger.info(`Peer's chain has less work (${peerCumulativeDifficulty} <= ${ourCumulativeDifficulty}), keeping our chain`);
        return;
      }
      
      logger.info(`Peer's chain has more work (${peerCumulativeDifficulty} > ${ourCumulativeDifficulty}), fetching blocks...`);
      
      // fetch all blocks from peer
      const blocks = [];
      for (let height = 1; height <= peerHeight; height++) {
        const peerBlocks = await this.config.peerManager.requestBlocks(peer, height);
        if (peerBlocks.length === 0) {
          logger.error(`Failed to fetch block ${height} from peer`);
          return;
        }
        blocks.push(...peerBlocks);
      }
      
      // verify the chain has more cumulative work
      let cumulativeDifficulty = BigInt(this.config.blockchain.getChainConfig().initialDifficulty);
      for (const block of blocks) {
        cumulativeDifficulty += BigInt(block.difficulty);
      }
      
      if (cumulativeDifficulty > ourCumulativeDifficulty) {
        logger.info(`Triggering reorganization to peer's chain with cumulative difficulty ${cumulativeDifficulty}`);
        
        // find common ancestor (usually genesis for completely different chains)
        const commonAncestorHeight = 0; // for now, assume divergence from genesis
        
        // trigger reorganization
        const blockClasses = blocks.map(b => BlockClass.fromObject(b));
        const success = await this.config.blockchain.reorganize(commonAncestorHeight, blockClasses);
        
        if (success) {
          logger.info(`Successfully reorganized to peer's chain`);
        } else {
          logger.error(`Failed to reorganize to peer's chain`);
        }
      }
    } catch (error: any) {
      logger.error(`Failed to fetch complete chain from peer: ${error.message}`);
    }
  }
  
  /**
   * force immediate sync
   */
  async syncNow(): Promise<void> {
    logger.info('Manual sync triggered');
    try {
      await this.checkAndSync();
    } catch (error: any) {
      logger.error('Error in syncNow:', error);
    }
  }
  
  /**
   * check if currently syncing
   */
  isSyncing(): boolean {
    return this.syncing;
  }
  
  /**
   * get sync status
   */
  getSyncStatus(): {
    syncing: boolean;
    currentHeight: number;
    targetHeight: number;
    progress: number;
  } | null {
    if (!this.syncing) {
      return null;
    }
    
    // this would need more detailed tracking for accurate progress
    return {
      syncing: true,
      currentHeight: 0, // would track this
      targetHeight: 0,  // would track this
      progress: 0       // percentage
    };
  }
}