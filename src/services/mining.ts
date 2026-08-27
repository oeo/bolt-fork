import { EventEmitter } from 'events';
import { Blockchain } from '../core/blockchain';
import { Mempool } from '../core/mempool';
import { getLogger } from '../utils/logger';
import { formatWatts } from '../utils/currency';
import { validateAddress } from '../crypto/address';
import { buildBlockCandidate } from './block-candidate';

const logger = getLogger(__filename);

export interface MiningStats {
  blocksFound: number;
  lastBlockTime?: number;
  totalReward: bigint;
  lastHashRate?: number; // hashes per second
  startTime?: number;
}

/**
 * simple mining service for development
 * 
 * this is a basic miner to keep the network alive during development
 * and early testing. production mining should use external software.
 */
export class MiningService extends EventEmitter {
  private blockchain: Blockchain;
  private mempool: Mempool;
  private enabled: boolean;
  private minerAddress: string;
  private interval: number;
  private maxIterations: number;
  private miningTimer?: NodeJS.Timeout;
  private stats: MiningStats;
  private isMining: boolean = false;
  private miningTask?: Promise<void>;
  
  constructor(options: {
    blockchain: Blockchain;
    mempool: Mempool;
    minerAddress: string;
    autoStart?: boolean;
    interval?: number;
    maxIterations?: number;
  }) {
    super();
    this.blockchain = options.blockchain;
    this.mempool = options.mempool;
    
    // use provided options or read from environment
    this.enabled = options.autoStart !== undefined ? options.autoStart : process.env.ENABLE_MINING === 'true';
    
    this.minerAddress = options.minerAddress;
    if (!validateAddress(this.minerAddress, this.blockchain.getChainConfig().addressPrefix)) {
      throw new Error('Invalid mining payout address for active network');
    }
    
    this.interval = options.interval || parseInt(process.env.MINING_INTERVAL || '30000'); // default 30s
    this.maxIterations = options.maxIterations || parseInt(process.env.MINING_MAX_ITERATIONS || '10000'); // very limited
    
    this.stats = {
      blocksFound: 0,
      totalReward: 0n,
      startTime: Date.now()
    };
    
    if (this.enabled) {
      logger.info('Mining service configured', {
        minerAddress: this.minerAddress,
        interval: `${this.interval / 1000}s`,
        maxIterations: this.maxIterations
      });
      if (options.autoStart) {
        this.start();
      }
    }
  }
  
  /**
   * start mining loop
   */
  start(): void {
    this.enabled = true;
    if (this.miningTimer) {
      return; // already running
    }
    
    logger.info('Mining service started');
    this.scheduleNextMine();
  }
  
  /**
   * stop mining
   */
  async stop(): Promise<void> {
    this.enabled = false;
    if (this.miningTimer) {
      clearTimeout(this.miningTimer);
      this.miningTimer = undefined;
    }
    await this.miningTask;
    
    logger.info('Mining service stopped', {
      blocksFound: this.stats.blocksFound,
      totalReward: formatWatts(this.stats.totalReward)
    });
  }
  
  /**
   * schedule next mining attempt
   */
  private scheduleNextMine(): void {
    this.miningTimer = setTimeout(() => {
      this.miningTimer = undefined;
      this.miningTask = this.mine();
      void this.miningTask.finally(() => {
        this.miningTask = undefined;
        if (this.enabled) this.scheduleNextMine();
      });
    }, this.interval);
  }
  
  /**
   * attempt to mine one block
   */
  private async mine(): Promise<void> {
    if (this.isMining) {
      return;
    }
    
    this.isMining = true;
    let currentHeight = -1;
    
    try {
      currentHeight = await this.blockchain.getHeight();
      const chainConfig = this.blockchain.getConfig();
      const candidate = await buildBlockCandidate(this.blockchain, this.mempool, this.minerAddress);
      const { block, transactions, blockReward, totalFees } = candidate;
      const height = block.index;
      const difficulty = block.difficulty;
      
      logger.debug(`Mining block ${height}`, {
        transactions: transactions.length,
        difficulty,
        maxIterations: this.maxIterations
      });
      
      // mine with limited iterations
      const miningResult = block.mine(chainConfig.hashAlgorithm, this.maxIterations);
      
      // calculate hash rate (hashes per second)
      const hashRate = miningResult.timeMs > 0 ? 
        (miningResult.iterations * 1000) / miningResult.timeMs : 0;
      this.stats.lastHashRate = hashRate;
      
      if (miningResult.success) {
        // check if chain height changed while we were mining
        const currentChainHeight = await this.blockchain.getHeight();
        if (currentChainHeight !== currentHeight) {
          logger.info(`Chain height changed while mining (was ${currentHeight}, now ${currentChainHeight}), restarting`);
          return;
        }
        
        // submit to blockchain
        const result = await this.blockchain.addBlock(block);
        
        if (!result.valid) {
          // check again if chain moved forward
          const latestHeight = await this.blockchain.getHeight();
          if (latestHeight !== currentHeight) {
            logger.info(`Chain advanced to height ${latestHeight}, abandoning stale block`);
          } else {
            logger.error('Block rejected by blockchain', { 
              error: result.error,
              height: block.index,
              hash: block.hash
            });
          }
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
          time: `${miningResult.timeMs}ms`,
          nonce: block.nonce,
          hashRate: `${Math.round(hashRate)} H/s`
        });
        
        // emit event for listeners with mining stats
        this.emit('blockMined', block, { hashRate, iterations: miningResult.iterations, timeMs: miningResult.timeMs });
      } else {
        logger.debug(`Mining attempt failed after ${this.maxIterations} iterations`);
      }
    } catch (error: any) {
      logger.error(`Mining error: ${error.message || error}`);
      logger.debug('Mining error details', {
        stack: error.stack,
        height: currentHeight + 1
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
