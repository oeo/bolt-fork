#!/usr/bin/env node

import { Blockchain } from './core/blockchain';
import { Mempool } from './core/mempool';
import { NetworkOrchestrator, NetworkMode } from './network/network-orchestrator';
import { ApiServer } from './api/server';
import { MiningService } from './services/mining';
import { getMetricsService } from './services/metrics';
import { createStorage } from './storage';
import { config as chainConfig } from './config/chain';
import { generateAddress } from './crypto/address';
import { getLogger } from './utils/logger';
import { serialize } from './utils/bigint';
import { TransactionClass } from './core/transaction';
import { IdentityManager } from './utils/identity';
import { serve } from 'bun';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('bolt-node-ipfs');

interface NodeConfig {
  // network
  apiPort: number;
  metricsPort: number;
  networkMode?: 'ipfs' | 'tcp' | 'hybrid';
  tcpPort?: number;
  
  // node identity
  nodeId: string;
  role: 'bootstrap' | 'miner' | 'full';
  
  // storage
  dataDir: string;
  redisUrl?: string;
  storageType?: string;
  
  // mining
  minerAddress?: string;
  miningEnabled?: boolean;
  
  // ipfs
  ipfsApi?: string;
}

class BoltIPFSNode {
  private config: NodeConfig;
  private identity!: IdentityManager;
  private storage: any;
  private blockchain!: Blockchain;
  private mempool!: Mempool;
  private networkOrchestrator?: NetworkOrchestrator;
  private api!: ApiServer;
  private miner?: MiningService;
  private metrics: any; // will use singleton
  private metricsServer: any;
  private running: boolean = false;
  
  constructor(config: NodeConfig) {
    this.config = config;
    this.setupSignalHandlers();
  }
  
  private setupSignalHandlers(): void {
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await this.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await this.stop();
      process.exit(0);
    });
    
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      console.error('Full error:', error);
      process.exit(1);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection:', {
        reason: reason,
        promise: promise,
        stack: reason instanceof Error ? reason.stack : undefined
      });
      console.error('Full rejection details:', reason);
      process.exit(1);
    });
  }
  
  async initialize(): Promise<void> {
    // ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
    
    // load or create node identity
    this.identity = new IdentityManager(this.config.dataDir, chainConfig.addressPrefix);
    const nodeIdentity = await this.identity.loadOrCreate();
    
    // override nodeId with address from identity
    this.config.nodeId = nodeIdentity.address;
    
    logger.info(`initializing bolt node ${this.identity.getDisplayName()} (${nodeIdentity.address}) with role: ${this.config.role}`);
    
    // create storage
    if (this.config.storageType === 'memory') {
      this.storage = createStorage('memory');
    } else {
      // default to lmdb
      const lmdbPath = path.join(this.config.dataDir, 'lmdb');
      this.storage = createStorage({
        type: 'lmdb',
        path: lmdbPath,
        mapSize: 100 * 1024 * 1024 * 1024 // 100GB
      });
    }
    
    await this.storage.connect();
    logger.info('Storage connected');
    
    // create blockchain
    this.blockchain = new Blockchain(this.storage, chainConfig);
    await this.blockchain.initialize();
    logger.info(`Blockchain initialized at height ${await this.blockchain.getHeight()}`);
    
    // setup blockchain event handlers for metrics
    this.setupBlockchainHandlers();
    
    // create mempool
    this.mempool = new Mempool(this.storage, chainConfig);
    await this.mempool.initialize();
    logger.info('Mempool initialized');
    
    // determine network mode
    const networkMode = this.config.networkMode || 'ipfs';
    const mode = networkMode === 'tcp' ? NetworkMode.TCP : 
                  networkMode === 'hybrid' ? NetworkMode.TCP :
                  NetworkMode.IPFS;
    
    // create network orchestrator
    this.networkOrchestrator = new NetworkOrchestrator({
      mode,
      identity: nodeIdentity,
      blockchain: this.blockchain,
      mempool: this.mempool,
      chainConfig,
      tcpPort: this.config.tcpPort || 8333,
      ipfsApi: this.config.ipfsApi,
      externalHost: process.env.NODE_HOST || 'localhost'
    });
    
    // setup network orchestrator event handlers
    this.setupNetworkHandlers();
    
    // create api server
    this.api = new ApiServer({
      port: this.config.apiPort,
      blockchain: this.blockchain,
      mempool: this.mempool,
      storage: this.storage,
    });
    
    // get metrics service singleton
    this.metrics = getMetricsService();
    this.metrics.setBlockchain(this.blockchain);
    this.metrics.setMempool(this.mempool);
    logger.info('Metrics service initialized');
    
    // create mining service if enabled
    if (this.config.miningEnabled) {
      const minerAddress = this.config.minerAddress || generateAddress(chainConfig.addressPrefix).address;
      this.miner = new MiningService({
        blockchain: this.blockchain,
        mempool: this.mempool,
        minerAddress,
        autoStart: true
      });
      logger.info(`Mining service initialized with address: ${minerAddress}`);
    }
    
    logger.info('Node initialization complete');
  }
  
  private setupBlockchainHandlers(): void {
    // record metrics for ALL blocks added to the chain, regardless of source
    this.blockchain.on('block:added', async (block) => {
      try {
        const blockSize = serialize(block).length;
        
        // separate coinbase from regular transactions
        let regularTxCount = 0;
        let coinbaseTx = null;
        let totalFees = 0n;
        
        if (block.transactions && block.transactions.length > 0) {
          for (const txData of block.transactions) {
            const tx = TransactionClass.fromObject(txData);
            
            if (tx.isCoinbase()) {
              coinbaseTx = tx;
            } else {
              // this is a regular transaction
              regularTxCount++;
              
              // record transaction processing metrics for non-coinbase transactions
              const txSize = serialize(txData).length;
              this.metrics.recordTransactionProcessing(0.001, txSize, tx.fee || 0n);
              totalFees += tx.fee || 0n;
            }
          }
        }
        
        // calculate block time (time between this block and previous)
        let blockTimeSeconds = 10; // default to 10 seconds if we can't calculate
        if (block.index > 0) {
          const prevBlock = await this.storage.getBlock(block.index - 1);
          if (prevBlock) {
            // timestamps are in milliseconds, convert to seconds
            blockTimeSeconds = Math.max(1, Math.floor((block.timestamp - prevBlock.timestamp) / 1000));
          }
        }
        
        // record block metrics with ONLY regular transaction count (excluding coinbase)
        this.metrics.recordBlockMined(blockTimeSeconds, blockSize, regularTxCount);
        
        // record mining success metrics (even if not locally mined)
        const reward = coinbaseTx ? coinbaseTx.amount : 0n;
        this.metrics.recordMiningSuccess(blockTimeSeconds, reward - totalFees);
        
        logger.debug(`Metrics recorded for block ${block.index} with ${regularTxCount} regular transactions (${block.transactions?.length || 0} total including coinbase)`);
      } catch (error: any) {
        logger.error('Failed to record block metrics:', error);
      }
    });
  }
  
  private setupNetworkHandlers(): void {
    // handle sync completion
    this.networkOrchestrator!.on('sync:complete', () => {
      logger.info('blockchain sync complete');
    });
  }
  
  
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Node already running');
      return;
    }
    
    logger.info('starting bolt node...');
    
    // start network services
    if (this.networkOrchestrator) {
      await this.networkOrchestrator.start();
      logger.info(`network services started in ${this.config.networkMode || 'tcp'} mode`);
    }
    
    // start api server
    await this.api.start();
    logger.info(`API server started on port ${this.config.apiPort}`);
    
    // start metrics server
    this.metricsServer = serve({
      port: this.config.metricsPort,
      fetch: async (request) => {
        const url = new URL(request.url);
        
        if (url.pathname === '/metrics') {
          try {
            // update node health metrics before serving
            let isSyncing = false;
            if (this.networkOrchestrator) {
              const stats = this.networkOrchestrator.getNetworkStats();
              isSyncing = stats.sync?.isSyncing || false;
            }
            this.metrics.updateNodeHealth(true, isSyncing, this.config.role);
            
            // update storage metrics
            await this.metrics.updateStorageMetrics(this.storage);
            
            // update network metrics
            let activePeers = 0;
            let totalPeers = 0;
            if (this.networkOrchestrator) {
              const peerCount = this.networkOrchestrator.getPeerCount();
              activePeers = peerCount;
              totalPeers = peerCount;
            }
            this.metrics.updateNetworkMetrics(activePeers, totalPeers);
            
            const metricsData = await this.metrics.getMetrics();
            return new Response(metricsData, {
              headers: {
                'Content-Type': this.metrics.getContentType(),
                'Cache-Control': 'no-cache, no-store, must-revalidate'
              }
            });
          } catch (error) {
            logger.error('Failed to generate metrics', error);
            return new Response('Internal Server Error', { status: 500 });
          }
        }
        
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'bolt-metrics'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        
        return new Response('Not Found', { status: 404 });
      }
    });
    logger.info(`Metrics server started on port ${this.config.metricsPort}`);
    
    // start mining if enabled
    if (this.miner) {
      this.miner.start();
      logger.info('Mining service started');
      
      // broadcast mined blocks to peers
      this.miner.on('blockMined', async (block, miningStats) => {
        try {
          logger.info(`Broadcasting mined block ${block.index} to peers`);
          
          // update hash rate metric when we mine locally
          if (miningStats && miningStats.hashRate) {
            const currentDifficulty = await this.blockchain.getDifficulty();
            this.metrics.updateMiningMetrics(miningStats.hashRate, currentDifficulty);
          }
          
          // note: block metrics are recorded in blockchain event handler
          // this ensures all blocks (local and remote) are tracked
          
          if (this.networkOrchestrator) {
            await this.networkOrchestrator.broadcastBlock(block);
          }
        } catch (error: any) {
          logger.error('Failed to broadcast block:', { 
            error: error.message
          });
        }
      });
    }
    
    // announce transactions when added to mempool
    this.mempool.on('transactionAdded', async (tx) => {
      try {
        // record mempool addition metric
        this.metrics.recordMempoolTransactionAdded();
        
        // note: transaction processing metrics are recorded when the tx is included in a block
        // this avoids double-counting for transactions that enter mempool then get mined
        
      } catch (error: any) {
        logger.error('Failed to record mempool transaction:', error.message);
      }
    });
    
    this.running = true;
    logger.info('Bolt IPFS node started successfully');
    
    // log initial status
    await this.logStatus();
    
    // periodic status logging
    setInterval(async () => await this.logStatus(), 60000); // every minute
    
    // periodic hash rate update (every 10 seconds)
    setInterval(async () => {
      if (this.miner) {
        const stats = this.miner.getStats();
        const currentDifficulty = await this.blockchain.getDifficulty();
        // use last hash rate if available, otherwise 0
        this.metrics.updateMiningMetrics(stats.lastHashRate || 0, currentDifficulty);
      }
    }, 10000);
  }
  
  private async logStatus(): Promise<void> {
    try {
      const height = await this.blockchain.getHeight();
      const tip = await this.blockchain.getLatestBlock();
      const tipHash = tip ? tip.hash.substring(0, 8) : 'genesis';
      let activePeers = 0;
      let syncing = false;
      
      if (this.networkOrchestrator) {
        activePeers = this.networkOrchestrator.getPeerCount();
        const stats = this.networkOrchestrator.getNetworkStats();
        syncing = stats.sync?.isSyncing || false;
      }
      
      logger.info(`[CHAIN TIP] node=${this.identity.getDisplayName()} height=${height} tip=${tipHash} peers=${activePeers} syncing=${syncing}`);
    } catch (error) {
      logger.error('Error logging status:', error);
    }
  }
  
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    
    logger.info('Stopping bolt IPFS node...');
    
    // stop mining first
    if (this.miner) {
      this.miner.stop();
      logger.info('Mining service stopped');
    }
    
    if (this.networkOrchestrator) {
      await this.networkOrchestrator.stop();
      logger.info('Network services stopped');
    }
    
    // stop api
    await this.api.stop();
    logger.info('API server stopped');
    
    // stop metrics server
    if (this.metricsServer) {
      this.metricsServer.stop();
      logger.info('Metrics server stopped');
    }
    
    // stop ipfs service
    
    // close storage
    await this.storage.close();
    logger.info('Storage closed');
    
    this.running = false;
    logger.info('Bolt IPFS node stopped');
  }
}

// parse configuration from environment
function parseConfig(): NodeConfig {
  const config: NodeConfig = {
    // network ports
    apiPort: parseInt(process.env.API_PORT || '7333'),
    metricsPort: parseInt(process.env.METRICS_PORT || '7336'),
    
    // node identity
    nodeId: process.env.NODE_ID || 'bolt-node',
    role: (process.env.NODE_ROLE as any) || 'full',
    
    // storage
    dataDir: process.env.DATA_DIR || './data',
    redisUrl: process.env.REDIS_URL,
    storageType: process.env.STORAGE_TYPE || 'lmdb',
    
    // mining
    minerAddress: process.env.MINER_ADDRESS,
    miningEnabled: process.env.MINING_ENABLED === 'true',
    
    // ipfs
    ipfsApi: process.env.IPFS_API || 'http://localhost:5001',
    
    // network mode (default to tcp)
    networkMode: (process.env.NETWORK_MODE as 'ipfs' | 'tcp') || 'tcp',
    tcpPort: parseInt(process.env.TCP_PORT || '8333')
  };
  
  return config;
}

// main entry point
async function main() {
  logger.info('starting bolt blockchain node with IPFS...');
  logger.info(`node version: 0.1.0`);
  logger.info(`network: ${chainConfig.name}`);
  
  const config = parseConfig();
  const node = new BoltIPFSNode(config);
  
  try {
    await node.initialize();
    await node.start();
    
    logger.info('node is running. press Ctrl+C to stop.');
    
    // keep process alive
    setInterval(() => {}, 1000);
    
  } catch (error) {
    logger.error('Failed to start node:', error);
    console.error('Full error:', error);
    process.exit(1);
  }
}

// run if main module
if (require.main === module) {
  main().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });
}

export { BoltIPFSNode, NodeConfig, parseConfig };
