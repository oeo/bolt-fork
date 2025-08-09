import { Blockchain } from '../core/blockchain';
import { Mempool } from '../core/mempool';
import { BlockClass } from '../core/block';
import { createCoinbaseTransaction } from '../core/transaction';
import { getLogger } from '../utils/logger';
import { formatWatts } from '../utils/currency';
import { calculateChainVersionHash } from '../config/chain';

const logger = getLogger(__filename);

export interface MiningStats {
  blocksFound: number;
  lastBlockTime?: number;
  totalReward: bigint;
}

/**
 * simple mining service for development
 * 
 * this is a basic miner to keep the network alive during development
 * and early testing. production mining should use external software.
 */
export class MiningService {
  private blockchain: Blockchain;
  private mempool: Mempool;
  private enabled: boolean;
  private minerAddress?: string;
  private interval: number;
  private maxIterations: number;
  private miningTimer?: NodeJS.Timeout;
  private stats: MiningStats;
  private isMining: boolean = false;
  
  constructor(blockchain: Blockchain, mempool: Mempool) {
    this.blockchain = blockchain;
    this.mempool = mempool;
    
    // read configuration from environment
    this.enabled = process.env.ENABLE_MINING === 'true';
    this.minerAddress = process.env.MINER_ADDRESS;
    this.interval = parseInt(process.env.MINING_INTERVAL || '30000'); // default 30s
    this.maxIterations = parseInt(process.env.MINING_MAX_ITERATIONS || '10000'); // very limited
    
    this.stats = {
      blocksFound: 0,
      totalReward: 0n
    };
    
    if (this.enabled && this.minerAddress) {
      logger.info('Mining service configured', {
        minerAddress: this.minerAddress,
        interval: `${this.interval / 1000}s`,
        maxIterations: this.maxIterations
      });
      this.start();
    } else if (this.enabled) {
      logger.warn('Mining enabled but no MINER_ADDRESS configured');
    }
  }
  
  /**
   * start mining loop
   */
  start(): void {
    if (!this.minerAddress) {
      logger.error('Cannot start mining without miner address');
      return;
    }
    
    if (this.miningTimer) {
      return; // already running
    }
    
    logger.info('Mining service started');
    this.scheduleNextMine();
  }
  
  /**
   * stop mining
   */
  stop(): void {
    if (this.miningTimer) {
      clearTimeout(this.miningTimer);
      this.miningTimer = undefined;
    }
    
    logger.info('Mining service stopped', {
      blocksFound: this.stats.blocksFound,
      totalReward: formatWatts(this.stats.totalReward)
    });
  }
  
  /**
   * schedule next mining attempt
   */
  private scheduleNextMine(): void {
    this.miningTimer = setTimeout(async () => {
      await this.mine();
      
      if (this.enabled) {
        this.scheduleNextMine();
      }
    }, this.interval);
  }
  
  /**
   * attempt to mine one block
   */
  private async mine(): Promise<void> {
    if (this.isMining || !this.minerAddress) {
      return;
    }
    
    this.isMining = true;
    
    try {
      const startTime = Date.now();
      
      // get blockchain state
      const currentHeight = await this.blockchain.getHeight();
      const height = currentHeight + 1;
      const previousBlock = await this.blockchain.getLatestBlock();
      
      if (!previousBlock) {
        throw new Error('No previous block found');
      }
      
      const difficulty = await this.blockchain.getDifficulty();
      const blockReward = this.blockchain.getBlockReward(height);
      
      // get blockchain config
      const config = this.blockchain.getConfig();
      const chainVersionHash = calculateChainVersionHash(config);
      
      // get transactions from mempool
      const transactions = this.mempool.getTransactionsForBlock();
      
      // calculate total fees
      let totalFees = 0n;
      for (const tx of transactions) {
        totalFees += tx.fee;
      }
      
      // create coinbase
      const coinbase = createCoinbaseTransaction(
        this.minerAddress,
        blockReward,
        totalFees,
        Date.now()
      );
      
      // create block
      const block = new BlockClass(
        height,
        Date.now(),
        previousBlock.hash,
        [coinbase.toObject(), ...transactions],
        difficulty,
        chainVersionHash,
        this.minerAddress
      );
      
      logger.debug(`Mining block ${height}`, {
        transactions: transactions.length,
        difficulty,
        maxIterations: this.maxIterations
      });
      
      // mine with limited iterations
      const success = block.mine(config.hashAlgorithm, this.maxIterations);
      
      if (success) {
        // submit to blockchain
        const result = await this.blockchain.addBlock(block);
        
        if (!result.valid) {
          logger.error('Block rejected by blockchain', { 
            error: result.error,
            height: block.index,
            hash: block.hash
          });
          return;
        }
        
        // remove mined transactions from mempool
        await this.mempool.removeBlockTransactions(transactions);
        
        // update stats
        this.stats.blocksFound++;
        this.stats.lastBlockTime = Date.now();
        this.stats.totalReward += blockReward + totalFees;
        
        logger.info(`Mined block ${height}`, {
          hash: block.hash,
          transactions: transactions.length,
          reward: formatWatts(blockReward + totalFees),
          time: `${Date.now() - startTime}ms`,
          nonce: block.nonce
        });
      } else {
        logger.debug(`Mining attempt failed after ${this.maxIterations} iterations`);
      }
    } catch (error: any) {
      logger.error('Mining error', { 
        error: error.message,
        stack: error.stack 
      });
    } finally {
      this.isMining = false;
    }
  }
  
  /**
   * get mining statistics
   */
  getStats(): MiningStats {
    return { ...this.stats };
  }
  
  /**
   * check if mining is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}