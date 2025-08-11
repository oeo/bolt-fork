import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { ConnectionManager } from './connection-manager';
import type { Protocol } from './protocol';
import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';

const logger = getLogger(__filename);

interface PeerInventory {
  blocks: Set<string>;
  transactions: Set<string>;
  lastUpdate: number;
}

interface InvItem {
  type: number; // 1 = tx, 2 = block
  hash: string;
}

export interface InventoryManagerConfig {
  connectionManager: ConnectionManager;
  protocol: Protocol;
  blockchain: Blockchain;
  mempool: Mempool;
  maxInventorySize?: number;
  inventoryTimeout?: number;
}

/**
 * manages inventory of what each peer has (blocks and transactions)
 */
export class InventoryManager extends EventEmitter {
  private config: InventoryManagerConfig;
  private peerInventory: Map<string, PeerInventory> = new Map();
  private recentAnnouncements: Set<string> = new Set();
  private cleanupTimer: any;
  
  constructor(config: InventoryManagerConfig) {
    super();
    this.config = {
      maxInventorySize: 50000,
      inventoryTimeout: 600000, // 10 minutes
      ...config
    };
    
    this.setupEventHandlers();
  }
  
  /**
   * setup event handlers
   */
  private setupEventHandlers(): void {
    // handle peer disconnections
    this.config.connectionManager.on('peer:disconnected', (peerId: string) => {
      this.removePeerInventory(peerId);
    });
  }
  
  /**
   * start inventory management
   */
  start(): void {
    logger.info('starting inventory manager');
    
    // periodic cleanup of old inventory
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldInventory();
    }, 60000); // every minute
  }
  
  /**
   * stop inventory management
   */
  stop(): void {
    logger.info('stopping inventory manager');
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    this.peerInventory.clear();
    this.recentAnnouncements.clear();
  }
  
  /**
   * handle inventory message from peer
   */
  handleInv(peerId: string, items: InvItem[]): void {
    logger.debug(`received inv with ${items.length} items from ${peerId}`);
    
    const inventory = this.getOrCreateInventory(peerId);
    const needed: InvItem[] = [];
    
    for (const item of items) {
      const key = `${item.type}:${item.hash}`;
      
      // track what peer has
      if (item.type === 2) { // block
        inventory.blocks.add(item.hash);
        
        // check if we need this block
        if (!this.config.blockchain.hasBlock(item.hash)) {
          needed.push(item);
        }
      } else if (item.type === 1) { // transaction
        inventory.transactions.add(item.hash);
        
        // check if we need this transaction
        if (!this.config.mempool.hasTransaction(item.hash)) {
          needed.push(item);
        }
      }
    }
    
    inventory.lastUpdate = Date.now();
    
    // request needed items
    if (needed.length > 0) {
      logger.info(`requesting ${needed.length} items from ${peerId}`);
      const message = this.config.protocol.encodeMessage('getdata', needed);
      this.config.connectionManager.sendMessage(peerId, message);
    }
    
    this.emit('inventory:updated', peerId, items);
  }
  
  /**
   * announce our inventory to peers
   */
  broadcastInventory(items: InvItem[]): void {
    if (items.length === 0) return;
    
    const peers = this.config.connectionManager.getConnectedPeers();
    logger.info(`broadcasting ${items.length} items to ${peers.length} peers`);
    
    for (const peerId of peers) {
      const inventory = this.peerInventory.get(peerId);
      
      // filter items peer doesn't have
      const filtered = items.filter(item => {
        if (!inventory) return true;
        
        if (item.type === 2) { // block
          return !inventory.blocks.has(item.hash);
        } else if (item.type === 1) { // transaction
          return !inventory.transactions.has(item.hash);
        }
        return true;
      });
      
      if (filtered.length > 0) {
        const message = this.config.protocol.encodeMessage('inv', filtered);
        this.config.connectionManager.sendMessage(peerId, message);
      }
    }
  }
  
  /**
   * announce new block to network
   */
  announceBlock(blockHash: string): void {
    // avoid duplicate announcements
    const key = `block:${blockHash}`;
    if (this.recentAnnouncements.has(key)) {
      return;
    }
    
    this.recentAnnouncements.add(key);
    
    // clean up after some time
    setTimeout(() => {
      this.recentAnnouncements.delete(key);
    }, 60000);
    
    this.broadcastInventory([{ type: 2, hash: blockHash }]);
  }
  
  /**
   * announce new transaction to network
   */
  announceTransaction(txHash: string): void {
    // avoid duplicate announcements
    const key = `tx:${txHash}`;
    if (this.recentAnnouncements.has(key)) {
      return;
    }
    
    this.recentAnnouncements.add(key);
    
    // clean up after some time
    setTimeout(() => {
      this.recentAnnouncements.delete(key);
    }, 60000);
    
    this.broadcastInventory([{ type: 1, hash: txHash }]);
  }
  
  /**
   * check if peer has a specific block
   */
  peerHasBlock(peerId: string, blockHash: string): boolean {
    const inventory = this.peerInventory.get(peerId);
    return inventory?.blocks.has(blockHash) || false;
  }
  
  /**
   * check if peer has a specific transaction
   */
  peerHasTransaction(peerId: string, txHash: string): boolean {
    const inventory = this.peerInventory.get(peerId);
    return inventory?.transactions.has(txHash) || false;
  }
  
  /**
   * get peers that have a specific block
   */
  getPeersWithBlock(blockHash: string): string[] {
    const peers: string[] = [];
    
    for (const [peerId, inventory] of this.peerInventory) {
      if (inventory.blocks.has(blockHash)) {
        peers.push(peerId);
      }
    }
    
    return peers;
  }
  
  /**
   * get peers that have a specific transaction
   */
  getPeersWithTransaction(txHash: string): string[] {
    const peers: string[] = [];
    
    for (const [peerId, inventory] of this.peerInventory) {
      if (inventory.transactions.has(txHash)) {
        peers.push(peerId);
      }
    }
    
    return peers;
  }
  
  /**
   * get or create inventory for peer
   */
  private getOrCreateInventory(peerId: string): PeerInventory {
    let inventory = this.peerInventory.get(peerId);
    
    if (!inventory) {
      inventory = {
        blocks: new Set(),
        transactions: new Set(),
        lastUpdate: Date.now()
      };
      this.peerInventory.set(peerId, inventory);
    }
    
    return inventory;
  }
  
  /**
   * remove peer inventory
   */
  private removePeerInventory(peerId: string): void {
    if (this.peerInventory.delete(peerId)) {
      logger.debug(`removed inventory for ${peerId}`);
    }
  }
  
  /**
   * cleanup old inventory entries
   */
  private cleanupOldInventory(): void {
    const now = Date.now();
    const timeout = this.config.inventoryTimeout!;
    
    for (const [peerId, inventory] of this.peerInventory) {
      // remove stale inventory
      if (now - inventory.lastUpdate > timeout) {
        logger.debug(`removing stale inventory for ${peerId}`);
        this.peerInventory.delete(peerId);
        continue;
      }
      
      // limit inventory size
      if (inventory.blocks.size > this.config.maxInventorySize!) {
        // keep only recent blocks (would need block heights for proper pruning)
        const toKeep = Array.from(inventory.blocks).slice(-this.config.maxInventorySize!);
        inventory.blocks = new Set(toKeep);
      }
      
      if (inventory.transactions.size > this.config.maxInventorySize!) {
        // keep only recent transactions
        const toKeep = Array.from(inventory.transactions).slice(-this.config.maxInventorySize!);
        inventory.transactions = new Set(toKeep);
      }
    }
  }
  
  /**
   * get inventory statistics
   */
  getStats(): {
    peerCount: number;
    totalBlocks: number;
    totalTransactions: number;
    recentAnnouncements: number;
  } {
    let totalBlocks = 0;
    let totalTransactions = 0;
    
    for (const inventory of this.peerInventory.values()) {
      totalBlocks += inventory.blocks.size;
      totalTransactions += inventory.transactions.size;
    }
    
    return {
      peerCount: this.peerInventory.size,
      totalBlocks,
      totalTransactions,
      recentAnnouncements: this.recentAnnouncements.size
    };
  }
}