import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { Transaction } from '../core/transaction';
import type { Mempool } from '../core/mempool';
import type { ConnectionManager } from './connection-manager';
import type { InventoryManager } from './inventory-manager';
import type { Protocol } from './protocol';

const logger = getLogger(__filename);

export interface TransactionRelayConfig {
  mempool: Mempool;
  connectionManager: ConnectionManager;
  inventoryManager: InventoryManager;
  protocol: Protocol;
  maxRecentTxs?: number;
  relayBatchSize?: number;
  relayInterval?: number; // ms
}

/**
 * manages transaction propagation across the network
 */
export class TransactionRelay extends EventEmitter {
  private config: TransactionRelayConfig;
  private recentTxs: Map<string, number> = new Map(); // hash -> timestamp
  private relayQueue: Set<Transaction> = new Set();
  private relayTimer: any;
  private isRunning: boolean = false;
  
  constructor(config: TransactionRelayConfig) {
    super();
    this.config = {
      maxRecentTxs: 10000,
      relayBatchSize: 100,
      relayInterval: 100, // 100ms
      ...config
    };
    
    this.setupEventHandlers();
  }
  
  /**
   * setup event handlers
   */
  private setupEventHandlers(): void {
    // listen for new transactions added to mempool
    this.config.mempool.on('transaction:added', (tx: Transaction) => {
      this.relayTransaction(tx);
    });
    
    // handle transaction requests
    this.config.connectionManager.on('message:received', (peerId: string, data: Uint8Array) => {
      const message = this.config.protocol.decodeMessage(data);
      if (message && message.command === 'getdata') {
        this.handleGetData(peerId, message.payload);
      }
    });
  }
  
  /**
   * start transaction relay service
   */
  start(): void {
    if (this.isRunning) return;
    
    logger.info('starting transaction relay');
    this.isRunning = true;
    
    // start relay timer
    this.relayTimer = setInterval(() => {
      this.processRelayQueue();
    }, this.config.relayInterval);
    
    // periodic cleanup of recent transactions
    setInterval(() => {
      this.cleanupRecentTxs();
    }, 60000); // every minute
  }
  
  /**
   * stop transaction relay service
   */
  stop(): void {
    if (!this.isRunning) return;
    
    logger.info('stopping transaction relay');
    this.isRunning = false;
    
    if (this.relayTimer) {
      clearInterval(this.relayTimer);
      this.relayTimer = null;
    }
    
    this.relayQueue.clear();
    this.recentTxs.clear();
  }
  
  /**
   * relay a new transaction to the network
   */
  relayTransaction(tx: Transaction): void {
    // check for duplicates
    if (this.recentTxs.has(tx.hash)) {
      logger.debug(`transaction ${tx.hash.substring(0, 8)}... already relayed recently`);
      return;
    }
    
    // mark as recent
    this.recentTxs.set(tx.hash, Date.now());
    
    // add to relay queue
    this.relayQueue.add(tx);
    
    logger.debug(`queued transaction ${tx.hash.substring(0, 8)}... for relay`);
  }
  
  /**
   * process relay queue
   */
  private processRelayQueue(): void {
    if (this.relayQueue.size === 0) return;
    
    // get batch of transactions to relay
    const batch = Array.from(this.relayQueue).slice(0, this.config.relayBatchSize);
    
    if (batch.length === 0) return;
    
    // remove from queue
    for (const tx of batch) {
      this.relayQueue.delete(tx);
    }
    
    // create inventory items
    const items = batch.map(tx => ({
      type: 1, // transaction
      hash: tx.hash
    }));
    
    // announce via inventory manager
    this.config.inventoryManager.broadcastInventory(items);
    
    logger.debug(`relayed ${batch.length} transactions to network`);
    this.emit('transactions:relayed', batch.length);
  }
  
  /**
   * handle getdata request for transactions
   */
  private handleGetData(peerId: string, items: any[]): void {
    const txRequests = items.filter(item => item.type === 1); // type 1 = transaction
    
    if (txRequests.length === 0) return;
    
    logger.debug(`received getdata for ${txRequests.length} transactions from ${peerId}`);
    
    for (const item of txRequests) {
      const tx = this.config.mempool.getTransaction(item.hash);
      
      if (tx) {
        // send transaction to peer
        this.sendTransaction(peerId, tx);
      } else {
        logger.debug(`transaction ${item.hash.substring(0, 8)}... not found in mempool`);
      }
    }
  }
  
  /**
   * send transaction to specific peer
   */
  private sendTransaction(peerId: string, tx: Transaction): void {
    try {
      // serialize transaction (simplified for now)
      const txData = {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        amount: tx.amount.toString(),
        fee: tx.fee.toString(),
        nonce: tx.nonce,
        timestamp: tx.timestamp,
        signature: tx.signature,
        publicKey: tx.publicKey
      };
      
      const message = this.config.protocol.encodeMessage('tx', txData);
      const sent = this.config.connectionManager.sendMessage(peerId, message);
      
      if (sent) {
        logger.debug(`sent transaction ${tx.hash.substring(0, 8)}... to ${peerId}`);
        this.emit('transaction:sent', tx.hash, peerId);
      }
    } catch (error) {
      logger.error(`failed to send transaction to ${peerId}:`, error);
    }
  }
  
  /**
   * handle incoming transaction from peer
   */
  async handleTransaction(peerId: string, txData: any): Promise<void> {
    try {
      // reconstruct transaction object
      const tx: Transaction = {
        hash: txData.hash,
        from: txData.from,
        to: txData.to,
        amount: BigInt(txData.amount),
        fee: BigInt(txData.fee),
        nonce: txData.nonce,
        timestamp: txData.timestamp,
        signature: txData.signature,
        publicKey: txData.publicKey
      };
      
      // check if we've seen this recently
      if (this.recentTxs.has(tx.hash)) {
        logger.debug(`ignoring duplicate transaction ${tx.hash.substring(0, 8)}...`);
        return;
      }
      
      // mark as recent
      this.recentTxs.set(tx.hash, Date.now());
      
      // add to mempool
      const added = await this.config.mempool.addTransaction(tx);
      
      if (added) {
        logger.info(`received new transaction ${tx.hash.substring(0, 8)}... from ${peerId}`);
        
        // relay to other peers
        this.relayTransaction(tx);
        
        this.emit('transaction:received', tx, peerId);
      }
    } catch (error) {
      logger.error(`failed to handle transaction from ${peerId}:`, error);
    }
  }
  
  /**
   * synchronize mempool with a peer
   */
  async syncMempool(peerId: string): Promise<void> {
    logger.info(`synchronizing mempool with ${peerId}`);
    
    // get our mempool transactions
    const ourTxs = this.config.mempool.getTransactions();
    
    if (ourTxs.length === 0) {
      logger.debug('no transactions to sync');
      return;
    }
    
    // announce our transactions
    const items = ourTxs.map(tx => ({
      type: 1, // transaction
      hash: tx.hash
    }));
    
    // send in batches
    const batchSize = 500;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const message = this.config.protocol.encodeMessage('inv', batch);
      this.config.connectionManager.sendMessage(peerId, message);
    }
    
    logger.info(`announced ${items.length} transactions to ${peerId}`);
  }
  
  /**
   * cleanup old entries from recent transactions
   */
  private cleanupRecentTxs(): void {
    const now = Date.now();
    const maxAge = 600000; // 10 minutes
    let removed = 0;
    
    for (const [hash, timestamp] of this.recentTxs) {
      if (now - timestamp > maxAge) {
        this.recentTxs.delete(hash);
        removed++;
      }
    }
    
    if (removed > 0) {
      logger.debug(`cleaned up ${removed} old transactions from recent list`);
    }
    
    // enforce max size
    if (this.recentTxs.size > this.config.maxRecentTxs!) {
      const toRemove = this.recentTxs.size - this.config.maxRecentTxs!;
      const entries = Array.from(this.recentTxs.entries())
        .sort((a, b) => a[1] - b[1]); // sort by timestamp
      
      for (let i = 0; i < toRemove; i++) {
        this.recentTxs.delete(entries[i][0]);
      }
      
      logger.debug(`pruned ${toRemove} transactions from recent list`);
    }
  }
  
  /**
   * get relay statistics
   */
  getStats(): {
    recentTxCount: number;
    queueSize: number;
    isRunning: boolean;
  } {
    return {
      recentTxCount: this.recentTxs.size,
      queueSize: this.relayQueue.size,
      isRunning: this.isRunning
    };
  }
}