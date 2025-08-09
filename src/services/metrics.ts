import { register, Counter, Gauge, Histogram } from 'prom-client';
import { getLogger } from '../utils/logger';
import { formatWatts } from '../utils/currency';

const logger = getLogger(__filename);

// Define metrics
export const metrics = {
  // Block metrics
  blocksTotal: new Counter({
    name: 'bolt_blocks_total',
    help: 'Total number of blocks mined',
    labelNames: ['network', 'miner']
  }),
  
  blockMiningDuration: new Histogram({
    name: 'bolt_block_mining_duration_seconds',
    help: 'Time spent mining blocks',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
  }),
  
  blockDifficulty: new Gauge({
    name: 'bolt_block_difficulty',
    help: 'Current block mining difficulty'
  }),
  
  blockSize: new Histogram({
    name: 'bolt_block_size_bytes',
    help: 'Size of mined blocks in bytes',
    buckets: [1000, 5000, 10000, 50000, 100000, 500000, 1000000]
  }),
  
  // Transaction metrics
  transactionsTotal: new Counter({
    name: 'bolt_transactions_total',
    help: 'Total number of transactions processed',
    labelNames: ['network', 'type'] // type: coinbase, transfer
  }),
  
  mempoolSize: new Gauge({
    name: 'bolt_mempool_size',
    help: 'Current number of transactions in mempool'
  }),
  
  mempoolBytes: new Gauge({
    name: 'bolt_mempool_bytes',
    help: 'Current size of mempool in bytes'
  }),
  
  transactionFees: new Histogram({
    name: 'bolt_transaction_fees_bolt',
    help: 'Transaction fees in BOLT',
    buckets: [0.001, 0.01, 0.1, 1, 10, 100] // BOLT amounts
  }),
  
  transactionAmount: new Histogram({
    name: 'bolt_transaction_amount_bolt',
    help: 'Transaction amounts in BOLT',
    buckets: [0.01, 0.1, 1, 10, 100, 1000, 10000] // BOLT amounts
  }),
  
  // Chain metrics
  chainHeight: new Gauge({
    name: 'bolt_chain_height',
    help: 'Current blockchain height (number of blocks)'
  }),
  
  cumulativeDifficulty: new Gauge({
    name: 'bolt_cumulative_difficulty',
    help: 'Total cumulative proof-of-work in the chain'
  }),
  
  totalSupply: new Gauge({
    name: 'bolt_total_supply_bolt',
    help: 'Total BOLT tokens in circulation (in BOLT)'
  }),
  
  // Mining metrics
  hashRate: new Gauge({
    name: 'bolt_hash_rate_hps',
    help: 'Estimated network hash rate in hashes per second'
  }),
  
  miningReward: new Gauge({
    name: 'bolt_mining_reward_bolt',
    help: 'Current block mining reward in BOLT'
  }),
  
  // Storage metrics
  storageOperations: new Counter({
    name: 'bolt_storage_operations_total',
    help: 'Total storage operations performed',
    labelNames: ['operation', 'adapter'] // operation: read, write, delete; adapter: memory, redis
  }),
  
  storageLatency: new Histogram({
    name: 'bolt_storage_latency_seconds',
    help: 'Storage operation latency',
    labelNames: ['operation', 'adapter'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
  }),
  
  // Account metrics
  accountsTotal: new Gauge({
    name: 'bolt_accounts_total',
    help: 'Total number of accounts with non-zero balance'
  }),
  
  accountBalance: new Histogram({
    name: 'bolt_account_balance_bolt',
    help: 'Distribution of account balances in BOLT',
    buckets: [0.01, 0.1, 1, 10, 100, 1000, 10000] // BOLT amounts
  })
};

/**
 * Initialize default metrics collection
 */
export function initializeMetrics() {
  // Clear any existing metrics
  register.clear();
  
  // Register all metrics
  Object.values(metrics).forEach(metric => {
    register.registerMetric(metric);
  });
  
  logger.info('Metrics registry initialized');
}

/**
 * Record block mining metrics
 */
export function recordBlockMined(
  network: string,
  miner: string,
  difficulty: number,
  miningTimeMs: number,
  blockSize: number,
  reward: bigint,
  height: number
) {
  metrics.blocksTotal.inc({ network, miner });
  metrics.blockMiningDuration.observe(miningTimeMs / 1000);
  metrics.blockDifficulty.set(difficulty);
  metrics.blockSize.observe(blockSize);
  
  // Convert BigInt to number safely - reward is in watts, so convert to BOLT for readability
  const rewardInBolt = Number(reward) / 100_000_000; // Convert watts to BOLT
  metrics.miningReward.set(rewardInBolt);
  metrics.chainHeight.set(height);
  
  logger.debug(`Recorded block mining metrics: height=${height}, difficulty=${difficulty}, time=${miningTimeMs}ms`);
}

/**
 * Record transaction metrics
 */
export function recordTransaction(
  network: string,
  type: 'coinbase' | 'transfer',
  amount: bigint,
  fee: bigint
) {
  metrics.transactionsTotal.inc({ network, type });
  
  // Convert BigInt amounts to BOLT for better readability in metrics
  const amountInBolt = Number(amount) / 100_000_000;
  const feeInBolt = Number(fee) / 100_000_000;
  
  metrics.transactionAmount.observe(amountInBolt);
  
  if (fee > 0n) {
    metrics.transactionFees.observe(feeInBolt);
  }
  
  logger.debug(`Recorded transaction metrics: type=${type}, amount=${formatWatts(amount)}, fee=${formatWatts(fee)}`);
}

/**
 * Update mempool metrics
 */
export function updateMempoolMetrics(size: number, bytes: number) {
  metrics.mempoolSize.set(size);
  metrics.mempoolBytes.set(bytes);
  
  logger.debug(`Updated mempool metrics: size=${size}, bytes=${bytes}`);
}

/**
 * Update chain metrics
 */
export function updateChainMetrics(
  height: number,
  cumulativeDifficulty: bigint,
  totalSupply: bigint,
  accountsCount: number
) {
  metrics.chainHeight.set(height);
  
  // Handle very large numbers safely
  const difficultyNumber = Number(cumulativeDifficulty);
  const supplyInBolt = Number(totalSupply) / 100_000_000; // Convert watts to BOLT
  
  metrics.cumulativeDifficulty.set(difficultyNumber);
  metrics.totalSupply.set(supplyInBolt); // Now in BOLT instead of watts
  metrics.accountsTotal.set(accountsCount);
  
  logger.debug(`Updated chain metrics: height=${height}, supply=${formatWatts(totalSupply)}, accounts=${accountsCount}`);
}

/**
 * Record storage operation metrics
 */
export function recordStorageOperation(
  operation: 'read' | 'write' | 'delete',
  adapter: 'memory' | 'redis',
  latencyMs: number
) {
  metrics.storageOperations.inc({ operation, adapter });
  metrics.storageLatency.observe({ operation, adapter }, latencyMs / 1000);
  
  logger.debug(`Recorded storage operation: ${operation} on ${adapter} took ${latencyMs}ms`);
}

/**
 * Record account balance metrics
 */
export function recordAccountBalance(balance: bigint) {
  // Convert balance from watts to BOLT for better readability
  const balanceInBolt = Number(balance) / 100_000_000;
  metrics.accountBalance.observe(balanceInBolt);
}

/**
 * Estimate and update hash rate
 */
export function updateHashRate(difficulty: number, blockTimeSeconds: number) {
  // Simple hash rate estimation: difficulty / block_time
  // This is a rough approximation as actual hash rate depends on the hash function
  const estimatedHashRate = difficulty / Math.max(blockTimeSeconds, 1);
  metrics.hashRate.set(estimatedHashRate);
  
  logger.debug(`Updated hash rate estimate: ${estimatedHashRate.toFixed(2)} H/s`);
}

/**
 * Get current metrics as string (for HTTP endpoint)
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get metrics registry for custom integrations
 */
export function getRegistry() {
  return register;
}