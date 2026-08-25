import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';
import type { ConnectionManager } from './connection-manager';
import type { Protocol } from './protocol';
import type { InventoryManager } from './inventory-manager';

const logger = getLogger(__filename);

interface DownloadRequest {
  hash: string;
  peerId: string;
  timestamp: number;
  retries: number;
}

export interface BlockDownloaderConfig {
  connectionManager: ConnectionManager;
  protocol: Protocol;
  inventoryManager?: InventoryManager;
  maxInFlight?: number;
  downloadTimeout?: number;
  maxRetries?: number;
}

/**
 * manages parallel block downloading from multiple peers
 */
export class BlockDownloader extends EventEmitter {
  private config: BlockDownloaderConfig;
  private queue: Set<string> = new Set();
  private inFlight: Map<string, DownloadRequest> = new Map();
  private downloading: boolean = false;
  private downloadTimer: any;
  
  constructor(config: BlockDownloaderConfig) {
    super();
    this.config = {
      maxInFlight: 16,
      downloadTimeout: 30000,
      maxRetries: 3,
      ...config
    };
  }
  
  /**
   * add blocks to download queue
   */
  queueBlocks(hashes: string[]): void {
    for (const hash of hashes) {
      if (!this.inFlight.has(hash)) {
        this.queue.add(hash);
      }
    }
    
    logger.info(`queued ${hashes.length} blocks, total queue: ${this.queue.size}`);
    
    if (!this.downloading) {
      this.startDownloading();
    }
  }
  
  /**
   * start downloading blocks
   */
  async startDownloading(): Promise<void> {
    if (this.downloading) return;
    
    this.downloading = true;
    logger.info('starting block downloads');
    
    // start timeout checker
    this.downloadTimer = setInterval(() => {
      this.checkTimeouts();
    }, 5000);
    
    // main download loop
    while (this.queue.size > 0 || this.inFlight.size > 0) {
      // check for timeouts
      this.checkTimeouts();
      
      // request more blocks if under limit
      while (this.inFlight.size < this.config.maxInFlight! && this.queue.size > 0) {
        const hash = this.queue.values().next().value;
        if (!hash) break;
        this.queue.delete(hash);
        
        const peer = this.selectPeerForBlock(hash);
        if (peer) {
          this.requestBlock(peer, hash);
        } else {
          // no peer available, put back in queue
          this.queue.add(hash);
          break;
        }
      }
      
      // wait before next iteration
      await Bun.sleep(100);
      
      // check if we should stop
      if (this.queue.size === 0 && this.inFlight.size === 0) {
        break;
      }
    }
    
    this.stopDownloading();
  }
  
  /**
   * stop downloading
   */
  stopDownloading(): void {
    if (!this.downloading) return;
    
    logger.info('stopping block downloads');
    this.downloading = false;
    
    if (this.downloadTimer) {
      clearInterval(this.downloadTimer);
      this.downloadTimer = null;
    }
    
    this.emit('download:complete');
  }
  
  /**
   * request a block from a peer
   */
  private requestBlock(peerId: string, hash: string): void {
    logger.debug(`requesting block ${hash.substring(0, 8)}... from ${peerId}`);
    
    // track in-flight request
    this.inFlight.set(hash, {
      hash,
      peerId,
      timestamp: Date.now(),
      retries: 0
    });
    
    // send getdata message
    const items = [{ type: 2, hash }]; // type 2 = block
    const message = this.config.protocol.encodeMessage('getdata', items);
    this.config.connectionManager.sendMessage(peerId, message);
    
    this.emit('block:requested', hash, peerId);
  }
  
  /**
   * handle received block
   */
  handleBlockReceived(peerId: string, blockHash: string): void {
    const request = this.inFlight.get(blockHash);
    if (!request) {
      logger.debug(`received unexpected block ${blockHash} from ${peerId}`);
      return;
    }
    
    // remove from in-flight
    this.inFlight.delete(blockHash);
    
    const downloadTime = Date.now() - request.timestamp;
    logger.debug(`received block ${blockHash.substring(0, 8)}... from ${peerId} in ${downloadTime}ms`);
    
    // update peer stats (for future peer selection)
    this.updatePeerStats(peerId, downloadTime, true);
    
    this.emit('block:received', blockHash, peerId);
  }
  
  /**
   * check for timed out requests
   */
  private checkTimeouts(): void {
    const now = Date.now();
    const timeout = this.config.downloadTimeout!;
    
    for (const [hash, request] of this.inFlight) {
      if (now - request.timestamp > timeout) {
        logger.warn(`block ${hash.substring(0, 8)}... timed out from ${request.peerId}`);
        
        // remove from in-flight
        this.inFlight.delete(hash);
        
        // update peer stats
        this.updatePeerStats(request.peerId, timeout, false);
        
        // retry with different peer
        if (request.retries < this.config.maxRetries!) {
          this.queue.add(hash);
          this.emit('block:retry', hash, request.retries + 1);
        } else {
          logger.error(`block ${hash.substring(0, 8)}... failed after ${request.retries} retries`);
          this.emit('block:failed', hash);
        }
      }
    }
  }
  
  /**
   * select best peer for downloading a block
   */
  private selectPeerForBlock(hash: string): string | null {
    const peers = this.config.connectionManager.getConnectedPeers();
    
    if (peers.length === 0) {
      logger.debug('no peers available for download');
      return null;
    }
    
    // if we have inventory manager, check who has the block
    if (this.config.inventoryManager) {
      const candidates = peers.filter(p => 
        this.config.inventoryManager!.peerHasBlock(p, hash)
      );
      
      if (candidates.length > 0) {
        // select peer with least in-flight requests
        return this.selectLeastBusyPeer(candidates);
      }
    }
    
    // fallback: select any peer with least in-flight
    return this.selectLeastBusyPeer(peers);
  }
  
  /**
   * select peer with least in-flight requests
   */
  private selectLeastBusyPeer(peers: string[]): string {
    const peerCounts = new Map<string, number>();
    
    // count in-flight per peer
    for (const request of this.inFlight.values()) {
      const count = peerCounts.get(request.peerId) || 0;
      peerCounts.set(request.peerId, count + 1);
    }
    
    // find peer with least requests
    let bestPeer = peers[0];
    let minRequests = peerCounts.get(bestPeer) || 0;
    
    for (const peer of peers) {
      const count = peerCounts.get(peer) || 0;
      if (count < minRequests) {
        bestPeer = peer;
        minRequests = count;
      }
    }
    
    return bestPeer;
  }
  
  /**
   * update peer download statistics
   */
  private updatePeerStats(peerId: string, downloadTime: number, success: boolean): void {
    // emit stats for external tracking
    this.emit('peer:stats', {
      peerId,
      downloadTime,
      success
    });
  }
  
  /**
   * get download statistics
   */
  getStats(): {
    queueSize: number;
    inFlightCount: number;
    downloading: boolean;
    avgDownloadTime?: number;
  } {
    return {
      queueSize: this.queue.size,
      inFlightCount: this.inFlight.size,
      downloading: this.downloading
    };
  }
  
  /**
   * clear download queue
   */
  clearQueue(): void {
    this.queue.clear();
    this.inFlight.clear();
    
    if (this.downloading) {
      this.stopDownloading();
    }
  }
}
