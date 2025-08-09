import { Registry, Counter, Gauge, Histogram, Summary, collectDefaultMetrics } from 'prom-client';
import { getLogger } from '../utils/logger';
import type { Blockchain } from '../core/blockchain';
import type { Mempool } from '../core/mempool';

const logger = getLogger(__filename);

/**
 * Comprehensive metrics service for bolt blockchain
 * Provides Prometheus metrics for monitoring and observability
 */
export class MetricsService {
  private registry: Registry;
  private blockchain?: Blockchain;
  private mempool?: Mempool;
  
  // blockchain metrics
  private blockHeight: Gauge;
  private blockDifficulty: Gauge;
  private cumulativeDifficulty: Gauge;
  private blocksMinedTotal: Counter;
  private blockProcessingTime: Histogram;
  private blockSize: Histogram;
  private transactionsPerBlock: Histogram;
  private blockValidationErrors: Counter;
  
  // mempool metrics
  private mempoolSize: Gauge;
  private mempoolBytes: Gauge;
  private mempoolTotalFees: Gauge;
  private mempoolMinFeePerByte: Gauge;
  private mempoolMaxFeePerByte: Gauge;
  private mempoolAvgFeePerByte: Gauge;
  private mempoolTransactionsAdded: Counter;
  private mempoolTransactionsRemoved: Counter;
  private mempoolTransactionsRejected: Counter;
  private mempoolEvictions: Counter;
  
  // transaction metrics
  private transactionProcessingTime: Histogram;
  private transactionSize: Histogram;
  private transactionFees: Histogram;
  private transactionValidationErrors: Counter;
  
  // mining metrics
  private miningHashRate: Gauge;
  private miningAttemptsTotal: Counter;
  private miningSuccessTotal: Counter;
  private miningTime: Histogram;
  private miningRevenue: Counter;
  private miningDifficulty: Gauge;
  
  // gbt (getblocktemplate) metrics
  private gbtTemplatesGenerated: Counter;
  private gbtTemplatesActive: Gauge;
  private gbtTemplatesCached: Gauge;
  private gbtTemplatesExpired: Counter;
  private gbtTemplateGenerationTime: Histogram;
  private gbtLongpollConnections: Gauge;
  private gbtBlockSubmissions: Counter;
  private gbtBlockSubmissionsValid: Counter;
  private gbtBlockSubmissionsInvalid: Counter;
  private gbtMempoolRefreshes: Counter;
  
  // network metrics (future)
  private networkPeersConnected: Gauge;
  private networkPeersTotal: Gauge;
  private networkMessagesReceived: Counter;
  private networkMessagesSent: Counter;
  private networkBandwidthIn: Counter;
  private networkBandwidthOut: Counter;
  
  // storage metrics
  private storageOperations: Counter;
  private storageLatency: Histogram;
  private storageErrors: Counter;
  private storageSize: Gauge;
  
  // api metrics
  private apiRequestsTotal: Counter;
  private apiRequestDuration: Histogram;
  private apiRequestErrors: Counter;
  private apiActiveConnections: Gauge;
  
  constructor() {
    this.registry = new Registry();
    
    // collect default nodejs metrics
    collectDefaultMetrics({ register: this.registry });
    
    // initialize blockchain metrics
    this.blockHeight = new Gauge({
      name: 'bolt_blockchain_height',
      help: 'Current blockchain height',
      registers: [this.registry]
    });
    
    this.blockDifficulty = new Gauge({
      name: 'bolt_blockchain_difficulty',
      help: 'Current mining difficulty',
      registers: [this.registry]
    });
    
    this.cumulativeDifficulty = new Gauge({
      name: 'bolt_blockchain_cumulative_difficulty',
      help: 'Total cumulative difficulty of the chain',
      registers: [this.registry]
    });
    
    this.blocksMinedTotal = new Counter({
      name: 'bolt_blocks_mined_total',
      help: 'Total number of blocks mined',
      registers: [this.registry]
    });
    
    this.blockProcessingTime = new Histogram({
      name: 'bolt_block_processing_seconds',
      help: 'Time to process and validate a block',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry]
    });
    
    this.blockSize = new Histogram({
      name: 'bolt_block_size_bytes',
      help: 'Block size in bytes',
      buckets: [1000, 5000, 10000, 50000, 100000, 500000, 1000000],
      registers: [this.registry]
    });
    
    this.transactionsPerBlock = new Histogram({
      name: 'bolt_transactions_per_block',
      help: 'Number of transactions in each block',
      buckets: [0, 1, 10, 50, 100, 500, 1000, 5000],
      registers: [this.registry]
    });
    
    this.blockValidationErrors = new Counter({
      name: 'bolt_block_validation_errors_total',
      help: 'Total number of block validation errors',
      labelNames: ['error_type'],
      registers: [this.registry]
    });
    
    // initialize mempool metrics
    this.mempoolSize = new Gauge({
      name: 'bolt_mempool_size',
      help: 'Number of transactions in mempool',
      registers: [this.registry]
    });
    
    this.mempoolBytes = new Gauge({
      name: 'bolt_mempool_bytes',
      help: 'Total size of mempool in bytes',
      registers: [this.registry]
    });
    
    this.mempoolTotalFees = new Gauge({
      name: 'bolt_mempool_total_fees_watts',
      help: 'Total fees of all transactions in mempool (in watts)',
      registers: [this.registry]
    });
    
    this.mempoolMinFeePerByte = new Gauge({
      name: 'bolt_mempool_min_fee_per_byte_watts',
      help: 'Minimum fee per byte in mempool (in watts)',
      registers: [this.registry]
    });
    
    this.mempoolMaxFeePerByte = new Gauge({
      name: 'bolt_mempool_max_fee_per_byte_watts',
      help: 'Maximum fee per byte in mempool (in watts)',
      registers: [this.registry]
    });
    
    this.mempoolAvgFeePerByte = new Gauge({
      name: 'bolt_mempool_avg_fee_per_byte_watts',
      help: 'Average fee per byte in mempool (in watts)',
      registers: [this.registry]
    });
    
    this.mempoolTransactionsAdded = new Counter({
      name: 'bolt_mempool_transactions_added_total',
      help: 'Total transactions added to mempool',
      registers: [this.registry]
    });
    
    this.mempoolTransactionsRemoved = new Counter({
      name: 'bolt_mempool_transactions_removed_total',
      help: 'Total transactions removed from mempool',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    this.mempoolTransactionsRejected = new Counter({
      name: 'bolt_mempool_transactions_rejected_total',
      help: 'Total transactions rejected from mempool',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    this.mempoolEvictions = new Counter({
      name: 'bolt_mempool_evictions_total',
      help: 'Total transactions evicted due to mempool limits',
      registers: [this.registry]
    });
    
    // initialize transaction metrics
    this.transactionProcessingTime = new Histogram({
      name: 'bolt_transaction_processing_seconds',
      help: 'Time to process and validate a transaction',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry]
    });
    
    this.transactionSize = new Histogram({
      name: 'bolt_transaction_size_bytes',
      help: 'Transaction size in bytes',
      buckets: [100, 250, 500, 1000, 2500, 5000, 10000],
      registers: [this.registry]
    });
    
    this.transactionFees = new Histogram({
      name: 'bolt_transaction_fees_watts',
      help: 'Transaction fees in watts',
      buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
      registers: [this.registry]
    });
    
    this.transactionValidationErrors = new Counter({
      name: 'bolt_transaction_validation_errors_total',
      help: 'Total number of transaction validation errors',
      labelNames: ['error_type'],
      registers: [this.registry]
    });
    
    // initialize mining metrics
    this.miningHashRate = new Gauge({
      name: 'bolt_mining_hash_rate',
      help: 'Current mining hash rate (hashes per second)',
      registers: [this.registry]
    });
    
    this.miningAttemptsTotal = new Counter({
      name: 'bolt_mining_attempts_total',
      help: 'Total number of mining attempts',
      registers: [this.registry]
    });
    
    this.miningSuccessTotal = new Counter({
      name: 'bolt_mining_success_total',
      help: 'Total number of successfully mined blocks',
      registers: [this.registry]
    });
    
    this.miningTime = new Histogram({
      name: 'bolt_mining_time_seconds',
      help: 'Time taken to mine a block',
      buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
      registers: [this.registry]
    });
    
    this.miningRevenue = new Counter({
      name: 'bolt_mining_revenue_watts',
      help: 'Total mining revenue in watts',
      registers: [this.registry]
    });
    
    this.miningDifficulty = new Gauge({
      name: 'bolt_mining_difficulty',
      help: 'Current mining difficulty target',
      registers: [this.registry]
    });
    
    // initialize gbt metrics
    this.gbtTemplatesGenerated = new Counter({
      name: 'bolt_gbt_templates_generated_total',
      help: 'Total number of block templates generated',
      registers: [this.registry]
    });
    
    this.gbtTemplatesActive = new Gauge({
      name: 'bolt_gbt_templates_active',
      help: 'Number of active block templates',
      registers: [this.registry]
    });
    
    this.gbtTemplatesCached = new Gauge({
      name: 'bolt_gbt_templates_cached',
      help: 'Number of cached block templates',
      registers: [this.registry]
    });
    
    this.gbtTemplatesExpired = new Counter({
      name: 'bolt_gbt_templates_expired_total',
      help: 'Total number of expired block templates',
      registers: [this.registry]
    });
    
    this.gbtTemplateGenerationTime = new Histogram({
      name: 'bolt_gbt_template_generation_seconds',
      help: 'Time to generate a block template',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry]
    });
    
    this.gbtLongpollConnections = new Gauge({
      name: 'bolt_gbt_longpoll_connections',
      help: 'Number of active longpoll connections',
      registers: [this.registry]
    });
    
    this.gbtBlockSubmissions = new Counter({
      name: 'bolt_gbt_block_submissions_total',
      help: 'Total number of block submissions',
      registers: [this.registry]
    });
    
    this.gbtBlockSubmissionsValid = new Counter({
      name: 'bolt_gbt_block_submissions_valid_total',
      help: 'Total number of valid block submissions',
      registers: [this.registry]
    });
    
    this.gbtBlockSubmissionsInvalid = new Counter({
      name: 'bolt_gbt_block_submissions_invalid_total',
      help: 'Total number of invalid block submissions',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    this.gbtMempoolRefreshes = new Counter({
      name: 'bolt_gbt_mempool_refreshes_total',
      help: 'Total number of template refreshes due to mempool changes',
      registers: [this.registry]
    });
    
    // initialize network metrics
    this.networkPeersConnected = new Gauge({
      name: 'bolt_network_peers_connected',
      help: 'Number of connected peers',
      registers: [this.registry]
    });
    
    this.networkPeersTotal = new Gauge({
      name: 'bolt_network_peers_total',
      help: 'Total number of known peers',
      registers: [this.registry]
    });
    
    this.networkMessagesReceived = new Counter({
      name: 'bolt_network_messages_received_total',
      help: 'Total number of network messages received',
      labelNames: ['message_type'],
      registers: [this.registry]
    });
    
    this.networkMessagesSent = new Counter({
      name: 'bolt_network_messages_sent_total',
      help: 'Total number of network messages sent',
      labelNames: ['message_type'],
      registers: [this.registry]
    });
    
    this.networkBandwidthIn = new Counter({
      name: 'bolt_network_bandwidth_in_bytes',
      help: 'Total incoming network bandwidth in bytes',
      registers: [this.registry]
    });
    
    this.networkBandwidthOut = new Counter({
      name: 'bolt_network_bandwidth_out_bytes',
      help: 'Total outgoing network bandwidth in bytes',
      registers: [this.registry]
    });
    
    // initialize storage metrics
    this.storageOperations = new Counter({
      name: 'bolt_storage_operations_total',
      help: 'Total number of storage operations',
      labelNames: ['operation', 'status'],
      registers: [this.registry]
    });
    
    this.storageLatency = new Histogram({
      name: 'bolt_storage_latency_seconds',
      help: 'Storage operation latency',
      labelNames: ['operation'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry]
    });
    
    this.storageErrors = new Counter({
      name: 'bolt_storage_errors_total',
      help: 'Total number of storage errors',
      labelNames: ['operation', 'error_type'],
      registers: [this.registry]
    });
    
    this.storageSize = new Gauge({
      name: 'bolt_storage_size_bytes',
      help: 'Total storage size in bytes',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    // initialize api metrics
    this.apiRequestsTotal = new Counter({
      name: 'bolt_api_requests_total',
      help: 'Total number of API requests',
      labelNames: ['method', 'endpoint', 'status'],
      registers: [this.registry]
    });
    
    this.apiRequestDuration = new Histogram({
      name: 'bolt_api_request_duration_seconds',
      help: 'API request duration',
      labelNames: ['method', 'endpoint'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry]
    });
    
    this.apiRequestErrors = new Counter({
      name: 'bolt_api_request_errors_total',
      help: 'Total number of API request errors',
      labelNames: ['method', 'endpoint', 'error_type'],
      registers: [this.registry]
    });
    
    this.apiActiveConnections = new Gauge({
      name: 'bolt_api_active_connections',
      help: 'Number of active API connections',
      labelNames: ['type'],
      registers: [this.registry]
    });
    
    logger.info('Metrics service initialized');
  }
  
  /**
   * Set blockchain instance for metrics collection
   */
  setBlockchain(blockchain: Blockchain): void {
    this.blockchain = blockchain;
  }
  
  /**
   * Set mempool instance for metrics collection
   */
  setMempool(mempool: Mempool): void {
    this.mempool = mempool;
  }
  
  /**
   * Update blockchain metrics
   */
  async updateBlockchainMetrics(): Promise<void> {
    if (!this.blockchain) return;
    
    try {
      const height = await this.blockchain.getHeight();
      const difficulty = await this.blockchain.getDifficulty();
      const cumulativeDifficulty = await this.blockchain.getCumulativeDifficulty();
      
      this.blockHeight.set(height);
      this.blockDifficulty.set(difficulty);
      this.cumulativeDifficulty.set(Number(cumulativeDifficulty));
    } catch (error) {
      logger.error('Failed to update blockchain metrics', { error });
    }
  }
  
  /**
   * Update mempool metrics
   */
  updateMempoolMetrics(): void {
    if (!this.mempool) return;
    
    try {
      const stats = this.mempool.getStats();
      
      this.mempoolSize.set(stats.size);
      this.mempoolBytes.set(stats.bytes);
      this.mempoolTotalFees.set(Number(stats.totalFees));
      this.mempoolMinFeePerByte.set(Number(stats.minFeePerByte));
      this.mempoolMaxFeePerByte.set(Number(stats.maxFeePerByte));
      this.mempoolAvgFeePerByte.set(Number(stats.avgFeePerByte));
    } catch (error) {
      logger.error('Failed to update mempool metrics', { error });
    }
  }
  
  /**
   * Record block mined
   */
  recordBlockMined(processingTime: number, blockSize: number, transactionCount: number): void {
    this.blocksMinedTotal.inc();
    this.blockProcessingTime.observe(processingTime);
    this.blockSize.observe(blockSize);
    this.transactionsPerBlock.observe(transactionCount);
  }
  
  /**
   * Record block validation error
   */
  recordBlockValidationError(errorType: string): void {
    this.blockValidationErrors.inc({ error_type: errorType });
  }
  
  /**
   * Record transaction added to mempool
   */
  recordMempoolTransactionAdded(): void {
    this.mempoolTransactionsAdded.inc();
  }
  
  /**
   * Record transaction removed from mempool
   */
  recordMempoolTransactionRemoved(reason: string): void {
    this.mempoolTransactionsRemoved.inc({ reason });
  }
  
  /**
   * Record transaction rejected from mempool
   */
  recordMempoolTransactionRejected(reason: string): void {
    this.mempoolTransactionsRejected.inc({ reason });
  }
  
  /**
   * Record mempool eviction
   */
  recordMempoolEviction(): void {
    this.mempoolEvictions.inc();
  }
  
  /**
   * Record transaction processing
   */
  recordTransactionProcessing(processingTime: number, size: number, fee: bigint): void {
    this.transactionProcessingTime.observe(processingTime);
    this.transactionSize.observe(size);
    this.transactionFees.observe(Number(fee));
  }
  
  /**
   * Record transaction validation error
   */
  recordTransactionValidationError(errorType: string): void {
    this.transactionValidationErrors.inc({ error_type: errorType });
  }
  
  /**
   * Update mining metrics
   */
  updateMiningMetrics(hashRate: number, difficulty: number): void {
    this.miningHashRate.set(hashRate);
    this.miningDifficulty.set(difficulty);
  }
  
  /**
   * Record mining attempt
   */
  recordMiningAttempt(): void {
    this.miningAttemptsTotal.inc();
  }
  
  /**
   * Record successful mining
   */
  recordMiningSuccess(miningTime: number, revenue: bigint): void {
    this.miningSuccessTotal.inc();
    this.miningTime.observe(miningTime);
    this.miningRevenue.inc(Number(revenue));
  }
  
  /**
   * Record GBT template generated
   */
  recordGbtTemplateGenerated(generationTime: number): void {
    this.gbtTemplatesGenerated.inc();
    this.gbtTemplateGenerationTime.observe(generationTime);
  }
  
  /**
   * Update GBT template counts
   */
  updateGbtTemplateCounts(active: number, cached: number): void {
    this.gbtTemplatesActive.set(active);
    this.gbtTemplatesCached.set(cached);
  }
  
  /**
   * Record GBT template expired
   */
  recordGbtTemplateExpired(): void {
    this.gbtTemplatesExpired.inc();
  }
  
  /**
   * Update GBT longpoll connections
   */
  updateGbtLongpollConnections(count: number): void {
    this.gbtLongpollConnections.set(count);
  }
  
  /**
   * Record GBT block submission
   */
  recordGbtBlockSubmission(valid: boolean, reason?: string): void {
    this.gbtBlockSubmissions.inc();
    if (valid) {
      this.gbtBlockSubmissionsValid.inc();
    } else {
      this.gbtBlockSubmissionsInvalid.inc({ reason: reason || 'unknown' });
    }
  }
  
  /**
   * Record GBT mempool refresh
   */
  recordGbtMempoolRefresh(): void {
    this.gbtMempoolRefreshes.inc();
  }
  
  /**
   * Update network metrics
   */
  updateNetworkMetrics(connectedPeers: number, totalPeers: number): void {
    this.networkPeersConnected.set(connectedPeers);
    this.networkPeersTotal.set(totalPeers);
  }
  
  /**
   * Record network message
   */
  recordNetworkMessage(direction: 'in' | 'out', messageType: string, bytes: number): void {
    if (direction === 'in') {
      this.networkMessagesReceived.inc({ message_type: messageType });
      this.networkBandwidthIn.inc(bytes);
    } else {
      this.networkMessagesSent.inc({ message_type: messageType });
      this.networkBandwidthOut.inc(bytes);
    }
  }
  
  /**
   * Record storage operation
   */
  recordStorageOperation(operation: string, status: 'success' | 'error', latency: number): void {
    this.storageOperations.inc({ operation, status });
    this.storageLatency.observe({ operation }, latency);
  }
  
  /**
   * Record storage error
   */
  recordStorageError(operation: string, errorType: string): void {
    this.storageErrors.inc({ operation, error_type: errorType });
  }
  
  /**
   * Update storage size
   */
  updateStorageSize(type: string, sizeBytes: number): void {
    this.storageSize.set({ type }, sizeBytes);
  }
  
  /**
   * Record API request
   */
  recordApiRequest(method: string, endpoint: string, status: number, duration: number): void {
    this.apiRequestsTotal.inc({ method, endpoint, status: status.toString() });
    this.apiRequestDuration.observe({ method, endpoint }, duration);
  }
  
  /**
   * Record API error
   */
  recordApiError(method: string, endpoint: string, errorType: string): void {
    this.apiRequestErrors.inc({ method, endpoint, error_type: errorType });
  }
  
  /**
   * Update API connections
   */
  updateApiConnections(type: string, count: number): void {
    this.apiActiveConnections.set({ type }, count);
  }
  
  /**
   * Get all metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    // update dynamic metrics before export
    await this.updateBlockchainMetrics();
    this.updateMempoolMetrics();
    
    return this.registry.metrics();
  }
  
  /**
   * Get content type for metrics
   */
  getContentType(): string {
    return this.registry.contentType;
  }
  
  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.registry.resetMetrics();
  }
  
  /**
   * Get registry for advanced usage
   */
  getRegistry(): Registry {
    return this.registry;
  }
}

// singleton instance
let metricsInstance: MetricsService | null = null;

/**
 * Get or create metrics service instance
 */
export function getMetricsService(): MetricsService {
  if (!metricsInstance) {
    metricsInstance = new MetricsService();
  }
  return metricsInstance;
}

/**
 * Reset metrics instance (mainly for testing)
 */
export function resetMetricsService(): void {
  if (metricsInstance) {
    metricsInstance.reset();
  }
  metricsInstance = null;
}