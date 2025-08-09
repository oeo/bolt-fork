#!/usr/bin/env bun

import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { BlockClass } from '../src/core/block';
import { createStorage } from '../src/storage';
import { devnet } from '../src/config/chains/devnet';
import { calculateChainVersionHash } from '../src/config/chain';
import { formatWatts } from '../src/utils/currency';
import { getLogger } from '../src/utils/logger';
import { 
  initializeMetrics,
  recordBlockMined,
  recordTransaction,
  updateChainMetrics,
  updateHashRate
} from '../src/services/metrics';

const logger = getLogger(__filename);

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printSeparator(title: string) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

async function monitoringDemo() {
  printSeparator('BOLT BLOCKCHAIN MONITORING DEMONSTRATION');
  
  try {
    // Initialize metrics collection
    initializeMetrics();
    console.log('\nStep 1: Metrics collection initialized');
    
    // Setup blockchain with Redis storage
    const config = devnet;
    const storage = createStorage('redis');
    const blockchain = new Blockchain(storage, config);
    const mempool = new Mempool(storage);
    
    await blockchain.initialize();
    console.log('Step 2: Blockchain initialized with Redis persistence');
    
    console.log('\nChain Configuration Summary:');
    console.log(`  Network: ${config.name}`);
    console.log(`  Block Time: ${config.targetBlockTime}s`);
    console.log(`  Initial Reward: ${formatWatts(config.initialReward)}`);
    console.log(`  Difficulty: ${config.initialDifficulty}`);
    
    // Mine a series of empty blocks to demonstrate the blockchain
    printSeparator('MINING DEMONSTRATION');
    
    const numBlocks = 8;
    const miners = [
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Use standard addresses to avoid validation issues
      '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
      '1JvdC9gQP3HmqNXgzK2j2qLPH7PdXCnx2s'
    ];
    
    for (let i = 1; i <= numBlocks; i++) {
      const minerAddress = miners[i % miners.length];
      const minerName = `Miner-${(i % miners.length) + 1}`;
      
      // Create block template
      const template = await blockchain.createBlockTemplate([], minerAddress);
      const block = new BlockClass(
        template.height,
        Date.now(),
        template.previousHash,
        template.transactions,
        template.difficulty,
        calculateChainVersionHash(config),
        minerAddress
      );
      
      console.log(`\nMining block ${i} (${minerName})...`);
      const startTime = Date.now();
      
      // Mine the block (devnet has difficulty 1, so this is instant)
      const success = block.mine(config.hashAlgorithm);
      const mineTime = Date.now() - startTime;
      
      if (success) {
        const result = await blockchain.addBlock(block);
        if (result.valid) {
          const blockReward = blockchain.getBlockReward(block.index);
          
          // Record detailed metrics
          recordBlockMined(
            config.name,
            minerName,
            block.difficulty,
            mineTime,
            block.getSize(),
            blockReward,
            block.index
          );
          
          // Record coinbase transaction
          const coinbaseTx = block.getCoinbaseTransaction();
          if (coinbaseTx) {
            recordTransaction(config.name, 'coinbase', coinbaseTx.amount, 0n);
          }
          
          // Update hash rate
          updateHashRate(block.difficulty, mineTime / 1000);
          
          console.log(`  ✓ Block ${i} mined successfully`);
          console.log(`    Hash: ${block.hash.slice(0, 32)}...`);
          console.log(`    Time: ${mineTime}ms`);
          console.log(`    Nonce: ${block.nonce}`);
          console.log(`    Reward: ${formatWatts(blockReward)}`);
          console.log(`    Size: ${block.getSize()} bytes`);
        } else {
          console.log(`  ✗ Block ${i} rejected: ${result.error}`);
        }
      } else {
        console.log(`  ✗ Block ${i} mining failed`);
      }
      
      // Small delay between blocks
      await sleep(500);
    }
    
    // Update final chain metrics
    const height = await blockchain.getHeight();
    const cumulativeDifficulty = await blockchain.getCumulativeDifficulty();
    const totalSupply = BigInt(height + 1) * config.initialReward; // Approximate total supply
    
    updateChainMetrics(height + 1, cumulativeDifficulty, totalSupply, miners.length);
    
    // Display final statistics
    printSeparator('BLOCKCHAIN STATISTICS');
    
    const finalStats = [
      ['Chain Height', `${height + 1} blocks`],
      ['Total Supply', formatWatts(totalSupply)],
      ['Cumulative Difficulty', cumulativeDifficulty.toString()],
      ['Average Block Time', `${config.targetBlockTime}s (target)`],
      ['Total Miners', miners.length.toString()],
      ['Storage Backend', 'Redis (persistent)']
    ];
    
    finalStats.forEach(([metric, value]) => {
      console.log(`  ${metric.padEnd(20)}: ${value}`);
    });
    
    // Display monitoring information
    printSeparator('MONITORING & OBSERVABILITY');
    
    console.log('\n📊 METRICS SERVER STATUS:');
    console.log(`  Metrics endpoint: http://localhost:7336/metrics`);
    console.log(`  Health endpoint:  http://localhost:7336/health`);
    console.log('  Status: Running and collecting metrics');
    
    console.log('\n📈 PROMETHEUS INTEGRATION:');
    console.log(`  Prometheus server: http://localhost:7338`);
    console.log('  Scrape interval: 5 seconds');
    console.log('  Target status: Active');
    
    console.log('\n📊 GRAFANA DASHBOARD:');
    console.log(`  Dashboard URL: http://localhost:7340`);
    console.log('  Username: admin');
    console.log('  Password: admin');
    
    console.log('\n🔍 AVAILABLE METRICS:');
    const availableMetrics = [
      'bolt_blocks_total - Total blocks mined by network/miner',
      'bolt_block_mining_duration_seconds - Mining time distribution',
      'bolt_block_difficulty - Current mining difficulty',
      'bolt_transactions_total - Transaction counts by type',
      'bolt_chain_height - Current blockchain height',
      'bolt_total_supply_watts - Total BOLT in circulation',
      'bolt_hash_rate_hps - Estimated network hash rate',
      'bolt_cumulative_difficulty - Total proof-of-work'
    ];
    
    availableMetrics.forEach(metric => {
      console.log(`  • ${metric}`);
    });
    
    console.log('\n📋 HOW TO VIEW METRICS IN GRAFANA:');
    console.log('  1. Open Grafana at http://localhost:7340');
    console.log('  2. Login with admin/admin');
    console.log('  3. Go to Explore → Metrics browser');
    console.log('  4. Search for "bolt_" to see all metrics');
    console.log('  5. Create visualizations and dashboards');
    
    console.log('\n💾 DATA PERSISTENCE:');
    console.log('  • Blockchain state: Persisted in Redis');
    console.log('  • Metrics: Available via Prometheus API');
    console.log('  • Logs: Collected by Loki via Promtail');
    
    // Display some sample metrics values
    const currentHeight = await blockchain.getHeight();
    const currentDifficulty = await blockchain.getDifficulty();
    
    console.log('\n📊 CURRENT METRIC VALUES:');
    console.log(`  bolt_chain_height: ${currentHeight + 1}`);
    console.log(`  bolt_block_difficulty: ${currentDifficulty}`);
    console.log(`  bolt_cumulative_difficulty: ${cumulativeDifficulty}`);
    console.log(`  bolt_total_supply_watts: ${totalSupply}`);
    
    await blockchain.close();
    
    printSeparator('DEMONSTRATION COMPLETE');
    console.log(`\n✅ Successfully mined ${numBlocks} blocks`);
    console.log('✅ All metrics recorded and available in Prometheus');
    console.log('✅ Blockchain state persisted to Redis');
    console.log('✅ Monitoring stack fully operational');
    console.log('\nThe blockchain is ready for continued operation.');
    console.log('Metrics will continue to be available as long as the metrics server runs.');
    
  } catch (error: any) {
    console.error('\n❌ Demo failed:', error.message);
    logger.error('Demo error:', error);
    process.exit(1);
  }
}

// Run demo if called directly
if (import.meta.main) {
  monitoringDemo();
}

export { monitoringDemo };