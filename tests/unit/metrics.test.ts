import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MetricsService, getMetricsService, resetMetricsService } from '../../src/services/metrics';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { MemoryAdapter } from '../../src/storage/memory';
import { devnet as chainConfig } from '../../src/config/chains/devnet';

describe('Metrics Service', async () => {
  let metrics: MetricsService;
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: MemoryAdapter;
  
  beforeEach(async () => {
    // reset singleton
    resetMetricsService();
    metrics = getMetricsService();
    
    // setup dependencies
    storage = new MemoryAdapter();
    await storage.connect();
    
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();
    
    mempool = new Mempool(storage);
    await mempool.initialize();
    
    // connect to metrics
    metrics.setBlockchain(blockchain);
    metrics.setMempool(mempool);
  });
  
  afterEach(async () => {
    await storage.close();
    resetMetricsService();
  });
  
  describe('initialization', async () => {
    test('should create metrics service instance', async () => {
      expect(metrics).toBeDefined();
      expect(metrics).toBeInstanceOf(MetricsService);
    });
    
    test('should return singleton instance', async () => {
      const metrics1 = getMetricsService();
      const metrics2 = getMetricsService();
      expect(metrics1).toBe(metrics2);
    });
    
    test('should reset metrics instance', async () => {
      const metrics1 = getMetricsService();
      resetMetricsService();
      const metrics2 = getMetricsService();
      expect(metrics1).not.toBe(metrics2);
    });
  });
  
  describe('blockchain metrics', async () => {
    test('should update blockchain metrics', async () => {
      await metrics.updateBlockchainMetrics();
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_blockchain_height 0');
      expect(metricsOutput).toContain('bolt_blockchain_difficulty');
      expect(metricsOutput).toContain('bolt_blockchain_cumulative_difficulty');
    });
    
    test('should record block mined', async () => {
      metrics.recordBlockMined(1.5, 1024, 10);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_blocks_mined_total 1');
    });
    
    test('should record block validation error', async () => {
      metrics.recordBlockValidationError('invalid_hash');
      metrics.recordBlockValidationError('invalid_timestamp');
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_block_validation_errors_total');
      expect(metricsOutput).toContain('error_type="invalid_hash"');
    });
  });
  
  describe('mempool metrics', async () => {
    test('should update mempool metrics', async () => {
      metrics.updateMempoolMetrics();
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_mempool_size 0');
      expect(metricsOutput).toContain('bolt_mempool_bytes 0');
      expect(metricsOutput).toContain('bolt_mempool_total_fees_watts');
    });
    
    test('should record mempool transaction operations', async () => {
      metrics.recordMempoolTransactionAdded();
      metrics.recordMempoolTransactionRemoved('included_in_block');
      metrics.recordMempoolTransactionRejected('insufficient_fee');
      metrics.recordMempoolEviction();
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_mempool_transactions_added_total 1');
      expect(metricsOutput).toContain('bolt_mempool_transactions_removed_total');
      expect(metricsOutput).toContain('bolt_mempool_transactions_rejected_total');
      expect(metricsOutput).toContain('bolt_mempool_evictions_total 1');
    });
  });
  
  describe('transaction metrics', async () => {
    test('should record transaction processing', async () => {
      metrics.recordTransactionProcessing(0.01, 250, 1000n);
      metrics.recordTransactionProcessing(0.02, 500, 5000n);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_transaction_processing_seconds');
      expect(metricsOutput).toContain('bolt_transaction_size_bytes');
      expect(metricsOutput).toContain('bolt_transaction_fees_watts');
    });
    
    test('should record transaction validation errors', async () => {
      metrics.recordTransactionValidationError('invalid_signature');
      metrics.recordTransactionValidationError('insufficient_balance');
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_transaction_validation_errors_total');
      expect(metricsOutput).toContain('error_type="invalid_signature"');
    });
  });
  
  describe('mining metrics', async () => {
    test('should update mining metrics', async () => {
      metrics.updateMiningMetrics(1000000, 100);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_mining_hash_rate 1000000');
      expect(metricsOutput).toContain('bolt_mining_difficulty 100');
    });
    
    test('should record mining operations', async () => {
      metrics.recordMiningAttempt();
      metrics.recordMiningAttempt();
      metrics.recordMiningSuccess(60, 50_000_000_000n);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_mining_attempts_total 2');
      expect(metricsOutput).toContain('bolt_mining_success_total 1');
      expect(metricsOutput).toContain('bolt_mining_revenue_watts');
    });
  });
  
  describe('GBT metrics', async () => {
    test('should record template operations', async () => {
      metrics.recordGbtTemplateGenerated(0.05);
      metrics.updateGbtTemplateCounts(3, 5);
      metrics.recordGbtTemplateExpired();
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_gbt_templates_generated_total 1');
      expect(metricsOutput).toContain('bolt_gbt_templates_active 3');
      expect(metricsOutput).toContain('bolt_gbt_templates_cached 5');
      expect(metricsOutput).toContain('bolt_gbt_templates_expired_total 1');
    });
    
    test('should record block submissions', async () => {
      metrics.recordGbtBlockSubmission(true);
      metrics.recordGbtBlockSubmission(false, 'invalid_nonce');
      metrics.recordGbtBlockSubmission(false, 'expired_template');
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_gbt_block_submissions_total 3');
      expect(metricsOutput).toContain('bolt_gbt_block_submissions_valid_total 1');
      expect(metricsOutput).toContain('bolt_gbt_block_submissions_invalid_total');
    });
    
    test('should track longpoll and refreshes', async () => {
      metrics.updateGbtLongpollConnections(5);
      metrics.recordGbtMempoolRefresh();
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_gbt_longpoll_connections 5');
      expect(metricsOutput).toContain('bolt_gbt_mempool_refreshes_total 1');
    });
  });
  
  describe('network metrics', async () => {
    test('should update network peer counts', async () => {
      metrics.updateNetworkMetrics(10, 50);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_network_peers_connected 10');
      expect(metricsOutput).toContain('bolt_network_peers_total 50');
    });
    
    test('should record network messages', async () => {
      metrics.recordNetworkMessage('in', 'block', 1024);
      metrics.recordNetworkMessage('out', 'transaction', 256);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_network_messages_received_total');
      expect(metricsOutput).toContain('message_type="block"');
      expect(metricsOutput).toContain('bolt_network_bandwidth_in_bytes 1024');
      expect(metricsOutput).toContain('bolt_network_bandwidth_out_bytes 256');
    });
  });
  
  describe('storage metrics', async () => {
    test('should record storage operations', async () => {
      metrics.recordStorageOperation('save_block', 'success', 0.01);
      metrics.recordStorageOperation('get_block', 'error', 0.05);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_storage_operations_total');
      expect(metricsOutput).toContain('operation="save_block"');
      expect(metricsOutput).toContain('status="success"');
    });
    
    test('should record storage errors', async () => {
      metrics.recordStorageError('save_block', 'connection_timeout');
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_storage_errors_total');
      expect(metricsOutput).toContain('error_type="connection_timeout"');
    });
    
    test('should update storage size', async () => {
      metrics.updateStorageSize('blocks', 1024 * 1024);
      metrics.updateStorageSize('state', 512 * 1024);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_storage_size_bytes');
      expect(metricsOutput).toContain('type="blocks"');
    });
  });
  
  describe('API metrics', async () => {
    test('should record API requests', async () => {
      metrics.recordApiRequest('GET', '/blocks', 200, 0.05);
      metrics.recordApiRequest('POST', '/transactions', 201, 0.1);
      metrics.recordApiRequest('GET', '/blocks/123', 404, 0.01);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_api_requests_total');
      expect(metricsOutput).toContain('method="GET"');
      expect(metricsOutput).toContain('status="200"');
    });
    
    test('should record API errors', async () => {
      metrics.recordApiError('POST', '/transactions', 'validation_error');
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_api_request_errors_total');
      expect(metricsOutput).toContain('error_type="validation_error"');
    });
    
    test('should track API connections', async () => {
      metrics.updateApiConnections('websocket', 5);
      metrics.updateApiConnections('http', 20);
      
      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_api_active_connections');
      expect(metricsOutput).toContain('type="websocket"');
    });
  });
  
  describe('prometheus format', async () => {
    test('should export metrics in prometheus format', async () => {
      // add some metrics
      metrics.recordBlockMined(1.0, 1000, 5);
      metrics.recordMempoolTransactionAdded();
      metrics.updateMiningMetrics(1000000, 100);
      
      const metricsOutput = await metrics.getMetrics();
      
      // check prometheus format
      expect(metricsOutput).toContain('# HELP');
      expect(metricsOutput).toContain('# TYPE');
      expect(metricsOutput).toContain('bolt_blocks_mined_total');
      expect(metricsOutput).toContain('bolt_mempool_transactions_added_total');
      expect(metricsOutput).toContain('bolt_mining_hash_rate');
    });
    
    test('should include default nodejs metrics', async () => {
      const metricsOutput = await metrics.getMetrics();
      
      // check for default metrics
      expect(metricsOutput).toContain('nodejs_version_info');
      expect(metricsOutput).toContain('process_cpu_user_seconds_total');
      expect(metricsOutput).toContain('nodejs_eventloop_lag_seconds');
    });
    
    test('should return correct content type', async () => {
      const contentType = metrics.getContentType();
      expect(contentType).toContain('text/plain');
      expect(contentType).toContain('version=0.0.4');
    });
  });
  
  describe('reset functionality', async () => {
    test('should reset all metrics', async () => {
      // add some metrics
      metrics.recordBlockMined(1.0, 1000, 5);
      metrics.recordMempoolTransactionAdded();
      
      let metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_blocks_mined_total 1');
      
      // reset
      metrics.reset();
      
      metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('bolt_blocks_mined_total 0');
    });
  });
  
  describe('error handling', async () => {
    test('should handle missing blockchain gracefully', async () => {
      const newMetrics = new MetricsService();
      // don't set blockchain
      
      await newMetrics.updateBlockchainMetrics();
      const metricsOutput = await newMetrics.getMetrics();
      
      // should still return metrics without errors
      expect(metricsOutput).toBeDefined();
      expect(metricsOutput).toContain('# HELP');
    });
    
    test('should handle missing mempool gracefully', async () => {
      const newMetrics = new MetricsService();
      // don't set mempool
      
      newMetrics.updateMempoolMetrics();
      const metricsOutput = await newMetrics.getMetrics();
      
      // should still return metrics without errors
      expect(metricsOutput).toBeDefined();
      expect(metricsOutput).toContain('# HELP');
    });
  });
});