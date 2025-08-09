# Metrics and monitoring

## Overview

bolt implements comprehensive metrics collection using Prometheus, providing deep observability into all aspects of the blockchain's operation.

## Architecture

The metrics system consists of:

### Core service (`src/services/metrics.ts`)
- Prometheus registry with 60+ metrics
- Singleton pattern for global access
- Automatic Node.js metrics collection
- Dynamic metric updates from blockchain state

### Metrics server (`scripts/metrics-server.ts`)
- HTTP server for Prometheus scraping
- Health and readiness endpoints
- Graceful shutdown handling

### Helper utilities (`src/utils/metrics-helper.ts`)
- Timing utilities for operations
- Metric recording wrappers
- Method decorators for automatic timing

## Metric categories

### Blockchain metrics
```
bolt_blockchain_height                    - Current blockchain height
bolt_blockchain_difficulty                - Current mining difficulty  
bolt_blockchain_cumulative_difficulty     - Total cumulative difficulty
bolt_blocks_mined_total                   - Total blocks mined
bolt_block_processing_seconds             - Block processing time histogram
bolt_block_size_bytes                     - Block size histogram
bolt_transactions_per_block               - Transactions per block histogram
bolt_block_validation_errors_total        - Validation errors by type
```

### Mempool metrics
```
bolt_mempool_size                         - Number of transactions
bolt_mempool_bytes                        - Total size in bytes
bolt_mempool_total_fees_watts             - Total fees in watts
bolt_mempool_min_fee_per_byte_watts       - Minimum fee per byte
bolt_mempool_max_fee_per_byte_watts       - Maximum fee per byte
bolt_mempool_avg_fee_per_byte_watts       - Average fee per byte
bolt_mempool_transactions_added_total     - Transactions added
bolt_mempool_transactions_removed_total   - Transactions removed by reason
bolt_mempool_transactions_rejected_total  - Transactions rejected by reason
bolt_mempool_evictions_total              - Transactions evicted
```

### Transaction metrics
```
bolt_transaction_processing_seconds       - Processing time histogram
bolt_transaction_size_bytes              - Transaction size histogram
bolt_transaction_fees_watts              - Transaction fees histogram
bolt_transaction_validation_errors_total - Validation errors by type
```

### Mining metrics
```
bolt_mining_hash_rate                    - Current hash rate (H/s)
bolt_mining_attempts_total               - Total mining attempts
bolt_mining_success_total                - Successfully mined blocks
bolt_mining_time_seconds                 - Time to mine block histogram
bolt_mining_revenue_watts                - Total mining revenue
bolt_mining_difficulty                   - Current difficulty target
```

### GetBlockTemplate (GBT) metrics
```
bolt_gbt_templates_generated_total       - Templates generated
bolt_gbt_templates_active                - Active templates
bolt_gbt_templates_cached                - Cached templates
bolt_gbt_templates_expired_total         - Expired templates
bolt_gbt_template_generation_seconds     - Generation time histogram
bolt_gbt_longpoll_connections            - Active longpoll connections
bolt_gbt_block_submissions_total         - Total submissions
bolt_gbt_block_submissions_valid_total   - Valid submissions
bolt_gbt_block_submissions_invalid_total - Invalid submissions by reason
bolt_gbt_mempool_refreshes_total         - Template refreshes
```

### Network metrics (ready for P2P)
```
bolt_network_peers_connected             - Connected peers
bolt_network_peers_total                 - Total known peers
bolt_network_messages_received_total     - Messages received by type
bolt_network_messages_sent_total         - Messages sent by type
bolt_network_bandwidth_in_bytes          - Incoming bandwidth
bolt_network_bandwidth_out_bytes         - Outgoing bandwidth
```

### Storage metrics
```
bolt_storage_operations_total            - Operations by type and status
bolt_storage_latency_seconds             - Operation latency histogram
bolt_storage_errors_total                - Errors by operation and type
bolt_storage_size_bytes                  - Storage size by type
```

### API metrics (ready for REST API)
```
bolt_api_requests_total                  - Requests by method/endpoint/status
bolt_api_request_duration_seconds        - Request duration histogram
bolt_api_request_errors_total            - Errors by method/endpoint/type
bolt_api_active_connections              - Active connections by type
```

## Usage

### Starting the metrics server
```bash
# Run standalone metrics server
bun run scripts/metrics-server.ts

# Or set environment variable
METRICS_PORT=7336 bun run scripts/metrics-server.ts
```

### Prometheus configuration
Add to `prometheus.yml`:
```yaml
scrape_configs:
  - job_name: 'bolt'
    static_configs:
      - targets: ['localhost:7336']
    scrape_interval: 15s
```

### Recording metrics in code
```typescript
import { getMetricsService } from './services/metrics';

const metrics = getMetricsService();

// Record block mined
metrics.recordBlockMined(processingTime, blockSize, txCount);

// Update mining metrics
metrics.updateMiningMetrics(hashRate, difficulty);

// Record transaction processing
metrics.recordTransactionProcessing(time, size, fee);
```

### Using helper utilities
```typescript
import { timeOperation, MetricTimer } from './utils/metrics-helper';

// Time an async operation
const result = await timeOperation(
  async () => await blockchain.addBlock(block),
  (duration, result) => metrics.recordBlockMined(duration, block.size, block.txCount)
);

// Manual timing
const timer = new MetricTimer();
// ... do work ...
const elapsed = timer.elapsed();
```

## Integration points

### Blockchain
- Block processing and validation
- Difficulty adjustments
- Chain reorganizations

### Mempool
- Transaction additions and removals
- Fee tracking
- Eviction events

### Mining service
- Hash rate calculation
- Block discovery
- Revenue tracking

### GetBlockTemplate service
- Template generation and caching
- Longpoll connections
- Block submissions

### Storage layer
- Operation timing
- Error tracking
- Size monitoring

## Grafana dashboards

### Blockchain dashboard
- Chain height over time
- Difficulty adjustments
- Block production rate
- Validation error rate

### Mempool dashboard
- Transaction flow (in/out)
- Fee distribution
- Size and capacity
- Eviction rate

### Mining dashboard
- Hash rate trends
- Block discovery rate
- Revenue accumulation
- Success rate

### Performance dashboard
- Block processing latency
- Transaction validation time
- Storage operation latency
- API response times

## Alert rules

### Critical alerts
```yaml
- alert: ChainStalled
  expr: increase(bolt_blockchain_height[5m]) == 0
  for: 10m
  annotations:
    summary: "Blockchain height not increasing"

- alert: HighValidationErrors
  expr: rate(bolt_block_validation_errors_total[5m]) > 0.1
  annotations:
    summary: "High block validation error rate"

- alert: MempoolFull
  expr: bolt_mempool_size / 10000 > 0.9
  annotations:
    summary: "Mempool at 90% capacity"
```

### Warning alerts
```yaml
- alert: LowHashRate
  expr: bolt_mining_hash_rate < 100000
  annotations:
    summary: "Mining hash rate below threshold"

- alert: HighStorageLatency
  expr: histogram_quantile(0.95, bolt_storage_latency_seconds) > 1
  annotations:
    summary: "Storage operations slow (p95 > 1s)"
```

## Testing

Comprehensive test coverage in `tests/unit/metrics.test.ts`:
- Metric recording and retrieval
- Prometheus format validation
- Error handling
- Singleton pattern
- All metric categories
- **29 tests, all passing**

Run tests:
```bash
bun test tests/unit/metrics.test.ts
```

### Phase 4.5 improvements
During the comprehensive testing phase, the metrics service was completely rewritten to:
- Support BigInt serialization for large numeric values
- Add proper Prometheus-compliant metric names and labels
- Implement all 60+ metrics across 8 categories
- Ensure thread-safe singleton access
- Add dynamic blockchain state metrics

## Performance considerations

- Metrics are collected in-memory with minimal overhead
- Histogram buckets are pre-configured for efficiency
- Dynamic metrics updated only on scrape
- No persistent storage required
- Negligible impact on blockchain performance

## Best practices

1. **Use appropriate metric types**
   - Counter: For values that only increase
   - Gauge: For values that can go up and down
   - Histogram: For distributions and percentiles

2. **Label cardinality**
   - Keep label values bounded
   - Avoid high-cardinality labels (user IDs, etc.)

3. **Metric naming**
   - Follow Prometheus conventions
   - Use `_total` suffix for counters
   - Use base units (seconds, bytes)

4. **Recording timing**
   - Record metrics after operations complete
   - Use helper utilities for consistency
   - Include both success and failure cases