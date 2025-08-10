import { serve } from 'bun';
import { Blockchain } from '../core/blockchain';
import { Mempool } from '../core/mempool';
import { BoltNode } from '../network/node';
import { StorageAdapter } from '../types';
import { getLogger } from '../utils/logger';
import { formatWatts } from '../utils/currency';
import { serialize, deserialize } from '../utils/bigint';

const logger = getLogger(__filename);

export interface ApiServerConfig {
  port?: number;
  host?: string;
  blockchain: Blockchain;
  mempool: Mempool;
  node?: BoltNode;
  storage: StorageAdapter;
  syncService?: any; // SyncService instance
}

/**
 * rest api server for bolt blockchain
 */
export class ApiServer {
  private server: any;
  private config: ApiServerConfig;
  private started: boolean = false;

  constructor(config: ApiServerConfig) {
    this.config = config;
  }

  /**
   * start the api server
   */
  async start(): Promise<void> {
    if (this.started) {
      logger.warn('API server already started');
      return;
    }

    const port = this.config.port || parseInt(process.env.API_PORT || '7333');
    const host = this.config.host || '0.0.0.0';

    this.server = serve({
      port,
      hostname: host,
      fetch: this.handleRequest.bind(this),
    });

    this.started = true;
    logger.info(`API server started on http://${host}:${port}`);
  }

  /**
   * handle incoming http requests
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // cors headers
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // handle options for cors
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    try {
      // route requests
      let result: any;

      // blockchain endpoints
      if (path === '/blocks' && method === 'GET') {
        result = await this.getBlocks(url);
      } else if (path.startsWith('/blocks/') && method === 'GET') {
        const hashOrHeight = path.split('/')[2];
        result = await this.getBlock(hashOrHeight);
      } else if (path === '/blockchain/info' && method === 'GET') {
        result = await this.getBlockchainInfo();
      }

      // transaction endpoints
      else if (path === '/transactions' && method === 'POST') {
        const text = await req.text();
        const body = deserialize(text);
        result = await this.submitTransaction(body);
      } else if (path.startsWith('/transactions/') && method === 'GET') {
        const hash = path.split('/')[2];
        result = await this.getTransaction(hash);
      }

      // account endpoints
      else if (path.startsWith('/accounts/') && path.endsWith('/balance') && method === 'GET') {
        const address = path.split('/')[2];
        result = await this.getBalance(address);
      } else if (path.startsWith('/accounts/') && path.endsWith('/nonce') && method === 'GET') {
        const address = path.split('/')[2];
        result = await this.getNonce(address);
      }

      // mempool endpoints
      else if (path === '/mempool' && method === 'GET') {
        result = await this.getMempoolInfo();
      } else if (path === '/mempool/transactions' && method === 'GET') {
        result = await this.getMempoolTransactions();
      }

      // network endpoints
      else if (path === '/network/status' && method === 'GET') {
        result = await this.getNetworkStatus();
      } else if (path === '/peers' && method === 'GET') {
        result = await this.getPeers();
      } else if (path === '/peers/connect' && method === 'POST') {
        const text = await req.text();
        const body = text ? deserialize(text) : {};
        result = await this.connectPeer(body.address);
      }

      // peer-to-peer endpoints
      else if (path === '/peer/status' && method === 'GET') {
        result = await this.getPeerStatus();
      } else if (path === '/peer/blocks' && method === 'GET') {
        const height = parseInt(url.searchParams.get('height') || '0');
        result = await this.getPeerBlocks(height);
      } else if (path === '/peer/blocks' && method === 'POST') {
        const text = await req.text();
        const block = deserialize(text);
        result = await this.receivePeerBlock(block);
      } else if (path === '/peer/transactions' && method === 'GET') {
        result = await this.getPeerTransactions();
      } else if (path === '/peer/transactions' && method === 'POST') {
        const text = await req.text();
        const transaction = deserialize(text);
        result = await this.receivePeerTransaction(transaction);
      }

      // health check
      else if (path === '/health' && method === 'GET') {
        result = { status: 'ok', timestamp: Date.now() };
      }

      // not found
      else {
        return new Response(
          JSON.stringify({ error: 'Endpoint not found' }),
          { status: 404, headers }
        );
      }

      // return result
      return new Response(
        serialize(result),
        { status: 200, headers }
      );

    } catch (error: any) {
      logger.error('API request failed', error);
      return new Response(
        JSON.stringify({ error: error.message || 'Internal server error' }),
        { status: 500, headers }
      );
    }
  }

  /**
   * get blocks with pagination
   */
  private async getBlocks(url: URL): Promise<any> {
    const limit = parseInt(url.searchParams.get('limit') || '10');
    const offset = parseInt(url.searchParams.get('offset') || '0');

    const height = await this.config.blockchain.getHeight();
    const blocks = [];

    for (let i = Math.max(0, height - offset); i >= Math.max(0, height - offset - limit + 1); i--) {
      const block = await this.config.blockchain.getBlock(i);
      if (block) {
        blocks.push(block);
      }
    }

    return {
      blocks,
      total: height + 1,
      limit,
      offset
    };
  }

  /**
   * get single block by hash or height
   */
  private async getBlock(hashOrHeight: string): Promise<any> {
    // check if it's a number (height) or hash
    const isHeight = /^\d+$/.test(hashOrHeight);

    if (isHeight) {
      const height = parseInt(hashOrHeight);
      const block = await this.config.blockchain.getBlock(height);
      if (!block) {
        throw new Error('Block not found');
      }
      return block;
    } else {
      const block = await this.config.blockchain.getBlockByHash(hashOrHeight);
      if (!block) {
        throw new Error('Block not found');
      }
      return block;
    }
  }

  /**
   * get blockchain info
   */
  private async getBlockchainInfo(): Promise<any> {
    const height = await this.config.blockchain.getHeight();
    const latestBlock = await this.config.blockchain.getLatestBlock();
    const difficulty = await this.config.blockchain.getDifficulty();
    const cumulativeDifficulty = await this.config.blockchain.getCumulativeDifficulty();
    const chainConfig = this.config.blockchain.getChainConfig();

    return {
      network: chainConfig.name,
      height,
      latestBlockHash: latestBlock?.hash,
      difficulty,
      cumulativeDifficulty,
      targetBlockTime: chainConfig.targetBlockTime,
      difficultyAdjustmentInterval: chainConfig.difficultyAdjustmentInterval,
      maxSupply: formatWatts(chainConfig.maxSupply),
      currentReward: formatWatts(this.config.blockchain.calculateBlockReward(height + 1))
    };
  }

  /**
   * submit a transaction
   */
  private async submitTransaction(txData: any): Promise<any> {
    // validate against account state if not coinbase
    if (txData.from) {
      const balance = await this.config.blockchain.getBalance(txData.from);
      const nonce = await this.config.blockchain.getNonce(txData.from);
      
      const { TransactionClass } = require('../core/transaction');
      const txClass = TransactionClass.fromObject(txData);
      const validation = txClass.validateAgainstAccount(balance, nonce);
      
      if (!validation.valid) {
        throw new Error(validation.error);
      }
    }
    
    // add to mempool - will throw if invalid
    await this.config.mempool.addTransaction(txData);

    // broadcast if node is available
    if (this.config.node && this.config.node.isStarted()) {
      await this.config.node.broadcastTransaction(txData);
    }

    return {
      hash: txData.hash,
      accepted: true,
      broadcasted: this.config.node?.isStarted() || false
    };
  }

  /**
   * get transaction by hash
   */
  private async getTransaction(hash: string): Promise<any> {
    // check mempool first
    const mempoolTx = this.config.mempool.getTransaction(hash);
    if (mempoolTx) {
      return {
        ...mempoolTx,
        status: 'pending',
        confirmations: 0
      };
    }

    // check blockchain
    const tx = await this.config.storage.getTransaction(hash);
    if (!tx) {
      throw new Error('Transaction not found');
    }

    // find block containing transaction
    const height = await this.config.blockchain.getHeight();
    let blockHeight = -1;

    for (let i = height; i >= 0; i--) {
      const block = await this.config.blockchain.getBlock(i);
      if (block && block.transactions.some(t => t.hash === hash)) {
        blockHeight = i;
        break;
      }
    }

    return {
      ...tx,
      status: 'confirmed',
      confirmations: blockHeight >= 0 ? height - blockHeight + 1 : 0,
      blockHeight
    };
  }

  /**
   * get account balance
   */
  private async getBalance(address: string): Promise<any> {
    const balance = await this.config.blockchain.getBalance(address);

    return {
      address,
      balance,
      formatted: formatWatts(balance)
    };
  }

  /**
   * get account nonce
   */
  private async getNonce(address: string): Promise<any> {
    const nonce = await this.config.blockchain.getNonce(address);

    return {
      address,
      nonce
    };
  }

  /**
   * get mempool info
   */
  private async getMempoolInfo(): Promise<any> {
    const stats = this.config.mempool.getStats();

    return {
      size: stats.size,
      bytes: stats.bytes,
      minFeePerByte: stats.minFeePerByte,
      maxFeePerByte: stats.maxFeePerByte,
      averageFeePerByte: stats.averageFeePerByte,
      totalFees: formatWatts(stats.totalFees)
    };
  }

  /**
   * get mempool transactions
   */
  private async getMempoolTransactions(): Promise<any> {
    const transactions = this.config.mempool.getTransactions();

    return {
      transactions,
      count: transactions.length
    };
  }

  /**
   * get network status
   */
  private async getNetworkStatus(): Promise<any> {
    if (!this.config.node) {
      return {
        error: 'Network node not available'
      };
    }

    const stats = this.config.node.getStats();
    const height = await this.config.blockchain.getHeight();

    return {
      peerId: stats.peerId,
      multiaddrs: stats.multiaddrs,
      connectedPeers: stats.peers,
      protocols: stats.protocols,
      topics: stats.subscribedTopics,
      blockHeight: height,
      syncing: false // TODO: implement sync status
    };
  }

  /**
   * get connected peers
   */
  private async getPeers(): Promise<any> {
    if (!this.config.node) {
      return {
        error: 'Network node not available'
      };
    }

    const peers = this.config.node.getPeers();

    return {
      peers,
      count: peers.length
    };
  }

  /**
   * connect to a peer
   */
  private async connectPeer(address: string): Promise<any> {
    if (!this.config.node) {
      throw new Error('Network node not available');
    }

    await this.config.node.connectToPeer(address);

    return {
      connected: true,
      address
    };
  }

  // peer-to-peer endpoint implementations

  /**
   * get peer status for synchronization
   */
  private async getPeerStatus(): Promise<any> {
    const height = await this.config.blockchain.getHeight();
    const latestBlock = await this.config.blockchain.getLatestBlock();
    const config = this.config.blockchain.getConfig();
    
    return {
      nodeId: process.env.NODE_ID || 'unknown',
      blockHeight: height,
      latestBlockHash: latestBlock?.hash || null,
      chainHash: latestBlock?.chainVersionHash || null,
      capabilities: [
        process.env.NODE_ROLE === 'miner' ? 'mining' : 'full_node'
      ],
      timestamp: Date.now()
    };
  }
  
  /**
   * get blocks for peer synchronization
   */
  private async getPeerBlocks(fromHeight: number): Promise<any> {
    const currentHeight = await this.config.blockchain.getHeight();
    const blocks = [];
    
    // limit to 100 blocks per request
    const limit = Math.min(100, currentHeight - fromHeight + 1);
    
    for (let i = 0; i < limit; i++) {
      const block = await this.config.blockchain.getBlock(fromHeight + i);
      if (block) {
        blocks.push(block);
      }
    }
    
    return blocks;
  }
  
  /**
   * receive block from peer
   */
  private async receivePeerBlock(block: any): Promise<any> {
    try {
      // convert to BlockClass and validate
      const { BlockClass } = await import('../core/block');
      const blockInstance = BlockClass.fromObject(block);
      
      // first try to add normally
      const result = await this.config.blockchain.addBlock(blockInstance);
      
      if (result.valid) {
        // remove transactions from mempool
        if (block.transactions && block.transactions.length > 0) {
          for (const tx of block.transactions) {
            await this.config.mempool.removeTransaction(tx.hash);
          }
        }
        
        logger.info(`Received and added block ${block.index} from peer`);
        return { success: true, height: block.index };
      } else if (result.error?.includes('Invalid previous hash')) {
        // this is a block from a competing chain
        logger.info(`Block ${block.index} from peer has different previous hash, checking for reorganization`);
        
        // handle as competing block
        const competingResult = await this.config.blockchain.handleCompetingBlock(blockInstance);
        
        if (competingResult.valid) {
          logger.info(`Reorganized to accept block ${block.index} from competing chain`);
          return { success: true };
        } else {
          logger.info(`Competing block ${block.index} rejected: ${competingResult.error}`);
          
          // still trigger sync to check for better chains
          if (this.config.syncService) {
            setImmediate(() => {
              this.config.syncService.syncNow().catch(err => 
                logger.error('Failed to trigger sync after competing block:', err)
              );
            });
          }
          
          return { success: false, error: competingResult.error || 'Competing chain has less work' };
        }
      } else {
        logger.warn(`Rejected block ${block.index} from peer: ${result.error}`);
        return { success: false, error: result.error };
      }
      
    } catch (error: any) {
      logger.error('Failed to process peer block:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * get mempool transactions for peer
   */
  private async getPeerTransactions(): Promise<any> {
    return this.config.mempool.getTransactions();
  }
  
  /**
   * receive transaction from peer
   */
  private async receivePeerTransaction(transaction: any): Promise<any> {
    try {
      // add to mempool
      await this.config.mempool.addTransaction(transaction);
      
      logger.debug(`Received transaction ${transaction.hash} from peer`);
      return { success: true, hash: transaction.hash };
      
    } catch (error: any) {
      logger.warn(`Failed to add peer transaction: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * stop the api server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.server) {
      this.server.stop();
    }

    this.started = false;
    logger.info('API server stopped');
  }
}