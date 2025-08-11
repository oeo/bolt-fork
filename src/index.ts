#!/usr/bin/env node

import { Blockchain } from './core/blockchain';
import { Mempool } from './core/mempool';
import { IPFSService } from './network/ipfs';
import { PeerManager } from './network/peer-manager';
import { ApiServer } from './api/server';
import { MiningService } from './services/mining';
import { SyncService } from './services/sync';
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
  private ipfs!: IPFSService;
  private peerManager!: PeerManager;
  private api!: ApiServer;
  private miner?: MiningService;
  private syncService!: SyncService;
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
    this.identity = new IdentityManager(this.config.dataDir);
    const nodeIdentity = await this.identity.loadOrCreate();
    
    // override nodeId with address from identity
    this.config.nodeId = nodeIdentity.address;
    
    logger.info(`initializing bolt node ${this.identity.getDisplayName()} (${nodeIdentity.address}) with role: ${this.config.role}`);
    
    // create storage
    if (this.config.storageType === 'redis' && this.config.redisUrl) {
      const url = new URL(this.config.redisUrl);
      this.storage = createStorage({
        type: 'redis',
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        password: url.password,
        keyPrefix: `bolt:${this.config.nodeId}:`
      });
    } else if (this.config.storageType === 'memory') {
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
    logger.info('Mempool initialized');
    
    // create ipfs service with identity address
    this.ipfs = new IPFSService({
      nodeId: this.identity.getNodeId(),
      chainConfig,
      apiUrl: this.config.ipfsApi
    });
    
    // create peer manager with identity address
    const nodeHost = process.env.NODE_HOST || 'bolt-node';
    const httpUrl = `http://${nodeHost}:${this.config.apiPort}`;
    this.peerManager = new PeerManager({
      ownNodeId: this.identity.getNodeId(),
      ownHttpUrl: httpUrl
    });
    
    // setup ipfs event handlers
    this.setupIPFSHandlers();
    
    // create sync service first
    this.syncService = new SyncService({
      blockchain: this.blockchain,
      peerManager: this.peerManager
    });
    
    // create api server with storage and sync service
    this.api = new ApiServer({
      port: this.config.apiPort,
      blockchain: this.blockchain,
      mempool: this.mempool,
      node: null, // we'll add ipfs stats via a different interface
      storage: this.storage,
      syncService: this.syncService
    });
    
    // get metrics service singleton
    this.metrics = getMetricsService();
    this.metrics.setBlockchain(this.blockchain);
    this.metrics.setMempool(this.mempool);
    logger.info('Metrics service initialized');
    
    // create mining service if enabled
    if (this.config.miningEnabled) {
      const minerAddress = this.config.minerAddress || generateAddress().address;
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
    this.blockchain.on('blockAdded', async (block) => {
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
  
  private setupIPFSHandlers(): void {
    // handle incoming blocks
    this.ipfs.on('block', async (message: any) => {
      try {
        const block = message.data;
        logger.info(`Received block #${block._id} via IPFS`);
        
        // validate and add to blockchain
        const success = await this.blockchain.addBlock(block);
        if (success) {
          logger.info(`Added block #${block._id} to chain`);
          // remove included transactions from mempool
          if (block.transactions) {
            for (const tx of block.transactions) {
              await this.mempool.removeTransaction(tx.hash);
            }
          }
        }
      } catch (error: any) {
        logger.error('Error handling block:', error);
      }
    });
    
    // handle incoming transactions
    this.ipfs.on('transaction', async (message: any) => {
      try {
        const tx = message.data;
        logger.debug(`Received transaction ${tx.hash} via IPFS`);
        
        // add to mempool
        await this.mempool.addTransaction(tx);
      } catch (error: any) {
        logger.error('Error handling transaction:', error);
      }
    });
    
    // handle peer announcements
    this.ipfs.on('peer', (message: any) => {
      logger.debug(`peer announcement from ${message.nodeId}`);
      
      // add discovered peer to peer manager (filter by identity address)
      if (message.httpUrl && message.nodeId !== this.identity.getNodeId()) {
        this.peerManager.addPeer({
          nodeId: message.nodeId,
          httpUrl: message.httpUrl,
          capabilities: message.data?.capabilities,
          blockHeight: message.data?.blockHeight,
          lastSeen: Date.now()
        });
      }
    });
    
    // handle mempool sync
    this.ipfs.on('mempool', async (message: any) => {
      // handle mempool synchronization messages
      logger.debug(`Mempool sync message: ${message.type}`);
    });
  }
  
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Node already running');
      return;
    }
    
    logger.info('Starting bolt IPFS node...');
    
    // start ipfs service
    await this.ipfs.start();
    logger.info('IPFS service started');
    
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
            const isSyncing = this.syncService.isSyncing();
            this.metrics.updateNodeHealth(true, isSyncing, this.config.role);
            
            // update storage metrics
            await this.metrics.updateStorageMetrics(this.storage);
            
            // update network metrics
            const peerStats = this.peerManager.getStats();
            this.metrics.updateNetworkMetrics(peerStats.activePeers, peerStats.totalPeers);
            
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
    
    // start sync service
    this.syncService.start();
    logger.info('Sync service started');
    
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
          
          await this.peerManager.broadcastBlock(block.toObject());
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
        
        await this.peerManager.broadcastTransaction(tx);
      } catch (error: any) {
        logger.error('Failed to broadcast transaction:', error.message);
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
      const ipfsStats = this.ipfs.getStats();
      const peerStats = this.peerManager.getStats();
      const height = await this.blockchain.getHeight();
      const syncing = this.syncService.isSyncing();
      
      logger.info(`node status: id=${this.identity.getDisplayName()}, role=${this.config.role}, activePeers=${peerStats.activePeers}, height=${height}, syncing=${syncing}`);
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
    
    // stop sync service
    this.syncService.stop();
    logger.info('Sync service stopped');
    
    // stop api
    await this.api.stop();
    logger.info('API server stopped');
    
    // stop metrics server
    if (this.metricsServer) {
      this.metricsServer.stop();
      logger.info('Metrics server stopped');
    }
    
    // stop ipfs service
    await this.ipfs.stop();
    logger.info('IPFS service stopped');
    
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
    ipfsApi: process.env.IPFS_API || 'http://localhost:5001'
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