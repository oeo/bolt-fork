# bolt metrics

## current scope

`src/services/metrics.ts` registers custom prometheus metric families and default node.js process metrics in a singleton registry. registration does not mean a metric is updated by production code. several registered families currently have no production integration.

metrics change through blockchain and mempool events, mining timers and events, api requests, and work performed immediately before a scrape.

api metric labels use finite values. methods normalize to `GET`, `POST`, or `OTHER`; routes normalize to active route templates or `unmatched`; errors normalize to `bad_request`, `not_found`, `method_not_allowed`, or `internal`.

## production updates

| trigger | current updates |
|---|---|
| every metrics scrape | blockchain height, difficulty, cumulative difficulty, and mempool gauges |
| integrated node scrape | node health, sync state, role, storage size, and peer counts before registry export |
| `block:added` event | accepted-block histograms and regular transaction count |
| local mining event | locally mined block count, mining success, mining time, mining revenue, and hash rate |
| `chain:reorganized` event | canonical reorganization count |
| `transactionAdded` event | mempool additions |
| mining event and timer | hash rate and mining difficulty |
| rest api request | request count, duration, and uncaught error count |

accepted remote blocks do not count as locally mined. transaction processing latency is not recorded because production does not currently measure validation duration.

no production caller currently updates gbt metrics, mining attempts, block or transaction validation errors, mempool removals, rejections or evictions, network message or bandwidth metrics, storage operation or error metrics, or active api connections. helper methods exist for these families, but their presence is not an integration guarantee.

## registered custom names

### blockchain

```text
bolt_blockchain_height
bolt_blockchain_difficulty
bolt_blockchain_cumulative_difficulty
bolt_chain_reorganizations_total
bolt_blocks_mined_total
bolt_block_processing_seconds
bolt_block_size_bytes
bolt_transactions_per_block
bolt_block_validation_errors_total
bolt_blockchain_block_size
bolt_blockchain_block_time
bolt_blockchain_transactions_total
```

### mempool

```text
bolt_mempool_size
bolt_mempool_bytes
bolt_mempool_total_fees_watts
bolt_mempool_min_fee_per_byte_watts
bolt_mempool_max_fee_per_byte_watts
bolt_mempool_avg_fee_per_byte_watts
bolt_mempool_transactions_added_total
bolt_mempool_transactions_removed_total
bolt_mempool_transactions_rejected_total
bolt_mempool_evictions_total
```

### transactions and mining

```text
bolt_transaction_processing_seconds
bolt_transaction_size_bytes
bolt_transaction_fees_watts
bolt_transaction_validation_errors_total
bolt_mining_hash_rate
bolt_mining_attempts_total
bolt_mining_success_total
bolt_mining_time_seconds
bolt_mining_revenue_watts
bolt_mining_difficulty
```

### getblocktemplate

```text
bolt_gbt_templates_generated_total
bolt_gbt_templates_active
bolt_gbt_templates_cached
bolt_gbt_templates_expired_total
bolt_gbt_template_generation_seconds
bolt_gbt_longpoll_connections
bolt_gbt_block_submissions_total
bolt_gbt_block_submissions_valid_total
bolt_gbt_block_submissions_invalid_total
bolt_gbt_mempool_refreshes_total
```

### network and storage

```text
bolt_network_peers_connected
bolt_network_peers_total
bolt_network_peers_inbound
bolt_network_peers_outbound
bolt_network_ready
bolt_network_messages_received_total
bolt_network_messages_sent_total
bolt_network_bandwidth_in_bytes
bolt_network_bandwidth_out_bytes
bolt_storage_operations_total
bolt_storage_latency_seconds
bolt_storage_errors_total
bolt_storage_size_bytes
```

### api and node health

```text
bolt_api_requests_total
bolt_api_request_duration_seconds
bolt_api_request_errors_total
bolt_api_active_connections
bolt_node_uptime_seconds
bolt_node_health
bolt_node_start_time_seconds
bolt_node_sync_status
bolt_node_role
```

histograms also expose prometheus-generated `_bucket`, `_sum`, and `_count` series.

## node metrics server

normal node startup serves metrics on `METRICS_HOST` and `METRICS_PORT`, default `127.0.0.1:7336`. compose binds inside the container and publishes the metrics port to host loopback.

| route | behavior |
|---|---|
| `GET /metrics` | updates integrated scrape-time values and returns prometheus text format |
| `GET /health` | returns json health data |
| any other path | returns `404` |

## standalone server

`scripts/metrics-server.ts` starts a separate registry process:

```bash
bun run scripts/metrics-server.ts
METRICS_PORT=7336 bun run scripts/metrics-server.ts
```

it serves `/metrics`, `/health`, and `/ready`. other paths return a plaintext endpoint summary. the standalone process does not inject blockchain, mempool, network, or storage instances, so it does not reproduce the node-integrated scrape updates.

example prometheus configuration:

```yaml
scrape_configs:
  - job_name: bolt
    static_configs:
      - targets: [localhost:7336]
    scrape_interval: 15s
```

compose configuration uses `bolt:7336` as the target.

## grafana dashboards

checked-in dashboards are:

- `compose/monitoring/grafana-provisioning/dashboards/blockchain-overview.json`, titled `Blockchain Overview`
- `compose/monitoring/grafana-provisioning/dashboards/node-health.json`, titled `Node Health`
