import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import { Block, Transaction } from '../types';
import { serialize, deserialize } from '../utils/bigint';

const logger = getLogger(__filename);

export interface PeerInfo {
  nodeId: string;
  httpUrl: string;
  capabilities?: string[];
  blockHeight?: number;
  chainHash?: string;
  cumulativeDifficulty?: string; // stored as string for BigInt compatibility
  lastSeen: number;
  isActive: boolean;
}

export interface PeerManagerConfig {
  ownNodeId: string;
  ownHttpUrl: string;
  maxPeers?: number;
  peerTimeout?: number; // milliseconds
}

/**
 * manages HTTP connections to discovered peers
 */
export class PeerManager extends EventEmitter {
  private config: PeerManagerConfig;
  private peers: Map<string, PeerInfo> = new Map();
  private activePeerIds: Set<string> = new Set();
  
  constructor(config: PeerManagerConfig) {
    super();
    this.config = {
      maxPeers: 50,
      peerTimeout: 60000, // 1 minute
      ...config
    };
    
    // periodically check peer health
    setInterval(() => this.checkPeerHealth(), 30000);
  }
  
  /**
   * add or update a discovered peer
   */
  addPeer(peer: Omit<PeerInfo, 'isActive'>): void {
    if (peer.nodeId === this.config.ownNodeId) {
      return; // don't add self
    }
    
    const existingPeer = this.peers.get(peer.nodeId);
    
    const peerInfo: PeerInfo = {
      ...peer,
      isActive: true,
      lastSeen: Date.now()
    };
    
    this.peers.set(peer.nodeId, peerInfo);
    this.activePeerIds.add(peer.nodeId);
    
    if (!existingPeer) {
      logger.info(`Added new peer: ${peer.nodeId} at ${peer.httpUrl}`);
      this.emit('peerAdded', peerInfo);
    } else {
      logger.debug(`Updated peer: ${peer.nodeId}`);
      this.emit('peerUpdated', peerInfo);
    }
  }
  
  /**
   * remove a peer
   */
  removePeer(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      this.peers.delete(nodeId);
      this.activePeerIds.delete(nodeId);
      logger.info(`Removed peer: ${nodeId}`);
      this.emit('peerRemoved', peer);
    }
  }
  
  /**
   * get all active peers
   */
  getActivePeers(): PeerInfo[] {
    return Array.from(this.peers.values()).filter(p => p.isActive);
  }
  
  /**
   * get peer by node ID
   */
  getPeer(nodeId: string): PeerInfo | undefined {
    return this.peers.get(nodeId);
  }
  
  /**
   * get best peer for syncing (highest cumulative difficulty)
   */
  getBestPeer(): PeerInfo | null {
    const activePeers = this.getActivePeers();
    if (activePeers.length === 0) return null;
    
    return activePeers.reduce((best, peer) => {
      if (!best) return peer;
      
      // compare by cumulative difficulty (proof-of-work)
      // remove 'n' suffix if present (BigInt notation)
      const bestDiffStr = (best.cumulativeDifficulty || '0').replace(/n$/, '');
      const peerDiffStr = (peer.cumulativeDifficulty || '0').replace(/n$/, '');
      const bestDifficulty = BigInt(bestDiffStr);
      const peerDifficulty = BigInt(peerDiffStr);
      
      if (peerDifficulty > bestDifficulty) {
        return peer;
      }
      
      // if equal difficulty, prefer higher block (tie-breaker)
      if (peerDifficulty === bestDifficulty && 
          (peer.blockHeight || 0) > (best.blockHeight || 0)) {
        return peer;
      }
      
      return best;
    }, null as PeerInfo | null);
  }
  
  /**
   * request blocks from a peer
   */
  async requestBlocks(peer: PeerInfo, fromHeight: number): Promise<Block[]> {
    try {
      const response = await fetch(
        `${peer.httpUrl}/peer/blocks?height=${fromHeight}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Id': this.config.ownNodeId
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.text();
      const blocks = deserialize(data) as Block[];
      
      logger.debug(`Received ${blocks.length} blocks from ${peer.nodeId}`);
      return blocks;
      
    } catch (error: any) {
      logger.error(`Failed to request blocks from ${peer.nodeId}:`, error.message);
      this.markPeerInactive(peer.nodeId);
      throw error;
    }
  }
  
  /**
   * send block to a peer
   */
  async sendBlock(peer: PeerInfo, block: Block): Promise<boolean> {
    try {
      const response = await fetch(
        `${peer.httpUrl}/peer/blocks`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Id': this.config.ownNodeId
          },
          body: serialize(block)
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      logger.debug(`Sent block ${block.index} to ${peer.nodeId}`);
      return true;
      
    } catch (error: any) {
      logger.error(`Failed to send block to ${peer.nodeId}:`, error.message);
      this.markPeerInactive(peer.nodeId);
      return false;
    }
  }
  
  /**
   * broadcast block to all active peers
   */
  async broadcastBlock(block: Block): Promise<void> {
    const peers = this.getActivePeers();
    const promises = peers.map(peer => this.sendBlock(peer, block));
    
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    logger.info(`Broadcast block ${block.index} to ${successful}/${peers.length} peers`);
  }
  
  /**
   * request transactions from a peer
   */
  async requestTransactions(peer: PeerInfo): Promise<Transaction[]> {
    try {
      const response = await fetch(
        `${peer.httpUrl}/peer/transactions`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Id': this.config.ownNodeId
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.text();
      const transactions = deserialize(data) as Transaction[];
      
      logger.debug(`Received ${transactions.length} transactions from ${peer.nodeId}`);
      return transactions;
      
    } catch (error: any) {
      logger.error(`Failed to request transactions from ${peer.nodeId}:`, error.message);
      this.markPeerInactive(peer.nodeId);
      throw error;
    }
  }
  
  /**
   * send transaction to a peer
   */
  async sendTransaction(peer: PeerInfo, transaction: Transaction): Promise<boolean> {
    try {
      const response = await fetch(
        `${peer.httpUrl}/peer/transactions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Id': this.config.ownNodeId
          },
          body: serialize(transaction)
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      logger.debug(`Sent transaction ${transaction.hash} to ${peer.nodeId}`);
      return true;
      
    } catch (error: any) {
      logger.error(`Failed to send transaction to ${peer.nodeId}:`, error.message);
      this.markPeerInactive(peer.nodeId);
      return false;
    }
  }
  
  /**
   * broadcast transaction to all active peers
   */
  async broadcastTransaction(transaction: Transaction): Promise<void> {
    const peers = this.getActivePeers();
    const promises = peers.map(peer => this.sendTransaction(peer, transaction));
    
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    logger.info(`Broadcast transaction ${transaction.hash} to ${successful}/${peers.length} peers`);
  }
  
  /**
   * get blockchain info from a peer
   */
  async getBlockchainInfo(peer: PeerInfo): Promise<any> {
    try {
      const response = await fetch(
        `${peer.httpUrl}/blockchain/info`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Id': this.config.ownNodeId
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const info = await response.json();
      
      // update peer with latest info
      this.addPeer({
        nodeId: peer.nodeId,
        httpUrl: peer.httpUrl,
        blockHeight: info.height,
        cumulativeDifficulty: info.cumulativeDifficulty,
        lastSeen: Date.now()
      });
      
      return info;
      
    } catch (error: any) {
      logger.error(`Failed to get blockchain info from ${peer.nodeId}:`, error.message);
      throw error;
    }
  }
  
  /**
   * get peer status
   */
  async getPeerStatus(peer: PeerInfo): Promise<any> {
    try {
      const response = await fetch(
        `${peer.httpUrl}/peer/status`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Node-Id': this.config.ownNodeId
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.text();
      const status = deserialize(data);
      
      // update peer info with latest status
      this.addPeer({
        nodeId: peer.nodeId,
        httpUrl: peer.httpUrl,
        blockHeight: status.blockHeight,
        chainHash: status.chainHash,
        cumulativeDifficulty: status.cumulativeDifficulty,
        capabilities: status.capabilities,
        lastSeen: Date.now()
      });
      
      return status;
      
    } catch (error: any) {
      logger.error(`Failed to get status from ${peer.nodeId}:`, error.message);
      this.markPeerInactive(peer.nodeId);
      throw error;
    }
  }
  
  /**
   * mark peer as inactive
   */
  private markPeerInactive(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.isActive = false;
      this.activePeerIds.delete(nodeId);
      logger.warn(`Marked peer ${nodeId} as inactive`);
    }
  }
  
  /**
   * check health of all peers
   */
  private async checkPeerHealth(): Promise<void> {
    const now = Date.now();
    const timeout = this.config.peerTimeout!;
    
    for (const [nodeId, peer] of this.peers) {
      // remove peers that haven't been seen recently
      if (now - peer.lastSeen > timeout * 2) {
        this.removePeer(nodeId);
        continue;
      }
      
      // mark peers as inactive if timeout exceeded
      if (now - peer.lastSeen > timeout && peer.isActive) {
        this.markPeerInactive(nodeId);
      }
      
      // try to reactivate inactive peers
      if (!peer.isActive && now - peer.lastSeen < timeout) {
        try {
          await this.getPeerStatus(peer);
          peer.isActive = true;
          this.activePeerIds.add(nodeId);
          logger.info(`Reactivated peer ${nodeId}`);
        } catch {
          // peer still unreachable
        }
      }
    }
  }
  
  /**
   * get statistics about peers
   */
  getStats(): {
    totalPeers: number;
    activePeers: number;
    inactivePeers: number;
    averageBlockHeight: number;
  } {
    const activePeers = this.getActivePeers();
    const totalHeight = activePeers.reduce((sum, p) => sum + (p.blockHeight || 0), 0);
    
    return {
      totalPeers: this.peers.size,
      activePeers: activePeers.length,
      inactivePeers: this.peers.size - activePeers.length,
      averageBlockHeight: activePeers.length > 0 ? Math.floor(totalHeight / activePeers.length) : 0
    };
  }
}