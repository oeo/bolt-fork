#!/usr/bin/env node

import { Blockchain } from './core/blockchain';
import { Mempool } from './core/mempool';
import { IPFSService } from './network/ipfs';
import { PeerManager } from './network/peer-manager';
import { ApiServer } from './api/server';
import { MiningService } from './services/mining';
import { SyncService } from './services/sync';
import { createStorage } from './storage';
import { config as chainConfig } from './config/chain';
import { generateAddress } from './crypto/address';
import { getLogger } from './utils/logger';
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
  
  // mining
  minerAddress?: string;
  miningEnabled?: boolean;
  
  // ipfs
  ipfsApi?: string;
}

class BoltIPFSNode {
  private config: NodeConfig;
  private storage: any;
  private blockchain!: Blockchain;
  private mempool!: Mempool;
  private ipfs!: IPFSService;
  private peerManager!: PeerManager;
  private api!: ApiServer;
  private miner?: MiningService;
  private syncService!: SyncService;
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
    logger.info(`Initializing bolt IPFS node ${this.config.nodeId} with role: ${this.config.role}`);
    
    // ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
    
    // create storage
    if (this.config.redisUrl) {
      const url = new URL(this.config.redisUrl);
      this.storage = createStorage({
        type: 'redis',
        host: url.hostname,
        port: parseInt(url.port || '6379'),
        password: url.password,
        keyPrefix: `bolt:${this.config.nodeId}:`
      });
    } else {
      this.storage = createStorage('memory');
    }
    
    await this.storage.connect();
    logger.info('Storage connected');
    
    // create blockchain
    this.blockchain = new Blockchain(this.storage, chainConfig);
    await this.blockchain.initialize();
    logger.info(`Blockchain initialized at height ${await this.blockchain.getHeight()}`);
    
    // create mempool
    this.mempool = new Mempool(this.storage, chainConfig);
    logger.info('Mempool initialized');
    
    // create ipfs service
    this.ipfs = new IPFSService({
      nodeId: this.config.nodeId,
      chainConfig,
      apiUrl: this.config.ipfsApi
    });
    
    // create peer manager
    const nodeHost = process.env.NODE_HOST || this.config.nodeId;
    const httpUrl = `http://${nodeHost}:${this.config.apiPort}`;
    this.peerManager = new PeerManager({
      ownNodeId: this.config.nodeId,
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
    
    // create mining service if enabled
    if (this.config.miningEnabled && this.config.role === 'miner') {
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
      logger.debug(`Peer announcement from ${message.nodeId}`);
      
      // add discovered peer to peer manager
      if (message.httpUrl && message.nodeId !== this.config.nodeId) {
        this.peerManager.addPeer({
          nodeId: message.nodeId,
          httpUrl: message.httpUrl,
          capabilities: message.data?.capabilities,
          blockHeight: message.data?.blockHeight,
          chainHash: message.chainVersionHash,
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
    
    // start sync service
    this.syncService.start();
    logger.info('Sync service started');
    
    // start mining if enabled
    if (this.miner) {
      this.miner.start();
      logger.info('Mining service started');
      
      // broadcast mined blocks to peers
      this.miner.on('blockMined', async (block) => {
        try {
          logger.info(`Broadcasting mined block ${block.index} to peers`);
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
  }
  
  private async logStatus(): Promise<void> {
    try {
      const ipfsStats = this.ipfs.getStats();
      const peerStats = this.peerManager.getStats();
      const height = await this.blockchain.getHeight();
      const syncing = this.syncService.isSyncing();
      
      logger.info(`Node status: id=${this.config.nodeId}, role=${this.config.role}, activePeers=${peerStats.activePeers}, height=${height}, syncing=${syncing}`);
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
    metricsPort: parseInt(process.env.METRICS_PORT || '9464'),
    
    // node identity
    nodeId: process.env.NODE_ID || 'bolt-node',
    role: (process.env.NODE_ROLE as any) || 'full',
    
    // storage
    dataDir: process.env.DATA_DIR || './data',
    redisUrl: process.env.REDIS_URL,
    
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
  logger.info('Starting bolt blockchain node with IPFS...');
  logger.info(`Node version: 0.1.0`);
  logger.info(`Network: ${chainConfig.name}`);
  
  const config = parseConfig();
  const node = new BoltIPFSNode(config);
  
  try {
    await node.initialize();
    await node.start();
    
    logger.info('Node is running. Press Ctrl+C to stop.');
    
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