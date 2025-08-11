#!/usr/bin/env bun

import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { BlockClass } from '../src/core/block';
import { TransactionClass, createCoinbaseTransaction, createSignedTransaction } from '../src/core/transaction';
import { createStorage } from '../src/storage';
import { devnet } from '../src/config/chains/devnet';
import { generateAddress } from '../src/crypto/address';
import { formatWatts } from '../src/utils/currency';
import { getLogger } from '../src/utils/logger';
import { 
  initializeMetrics,
  recordBlockMined,
  recordTransaction,
  updateMempoolMetrics,
  updateChainMetrics,
  updateHashRate,
  recordAccountBalance
} from '../src/services/metrics';

const logger = getLogger(__filename);

interface Actor {
  name: string;
  address: string;
  privateKey: string;
  publicKey: string;
  balance: bigint;
  nonce: number;
  role: 'miner' | 'trader' | 'whale' | 'retail';
  activity: string;
}

interface TransactionPlan {
  from: Actor;
  to: Actor;
  amount: bigint;
  fee: bigint;
  description: string;
  priority: number;
}

interface EconomicScenario {
  name: string;
  description: string;
  actors: Actor[];
  transactionPlans: TransactionPlan[];
  targetBlocks: number;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function printSectionHeader(title: string, description?: string) {
  console.log('\n' + '='.repeat(80));
  console.log(`  ${title}`);
  if (description) {
    console.log(`  ${description}`);
  }
  console.log('='.repeat(80));
}

function printTable(title: string, headers: string[], rows: string[][], width = 100) {
  console.log(`\n=== ${title} ===`);
  
  // Calculate column widths
  const widths = headers.map((header, i) => {
    const maxRowWidth = Math.max(...rows.map(row => row[i]?.length || 0));
    return Math.max(header.length, maxRowWidth);
  });
  
  // Print header
  const headerRow = headers.map((header, i) => header.padEnd(widths[i])).join(' | ');
  console.log(headerRow);
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'));
  
  // Print rows
  rows.forEach(row => {
    const dataRow = row.map((cell, i) => (cell || '').padEnd(widths[i])).join(' | ');
    console.log(dataRow);
  });
  console.log('');
}

function formatAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}...${address.slice(-6)}` : address;
}

function formatHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 20)}...` : hash;
}

function generateEconomicScenarios(): EconomicScenario[] {
  // Generate diverse actors
  const actors: Actor[] = [
    // Miners
    { ...generateAddress(devnet.addressPrefix), name: 'Genesis Mining', role: 'miner', activity: 'Industrial mining operation', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Satoshi Pool', role: 'miner', activity: 'Mining pool collective', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Green Energy Mining', role: 'miner', activity: 'Solar-powered mining', balance: 0n, nonce: 0 },
    
    // Whales
    { ...generateAddress(devnet.addressPrefix), name: 'Institutional Capital', role: 'whale', activity: 'Investment fund', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'DeFi Treasury', role: 'whale', activity: 'Protocol treasury', balance: 0n, nonce: 0 },
    
    // Traders
    { ...generateAddress(devnet.addressPrefix), name: 'Alpha Trading', role: 'trader', activity: 'Algorithmic trading', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Arbitrage Bot', role: 'trader', activity: 'Cross-exchange arbitrage', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Market Maker', role: 'trader', activity: 'Liquidity provision', balance: 0n, nonce: 0 },
    
    // Retail users
    { ...generateAddress(devnet.addressPrefix), name: 'Alice Cooper', role: 'retail', activity: 'HODLer and payments', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Bob Builder', role: 'retail', activity: 'DeFi user', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Carol Crypto', role: 'retail', activity: 'NFT collector', balance: 0n, nonce: 0 },
    { ...generateAddress(devnet.addressPrefix), name: 'Dave Developer', role: 'retail', activity: 'Smart contract deployer', balance: 0n, nonce: 0 }
  ];

  return [
    {
      name: 'Network Bootstrapping',
      description: 'Initial mining phase with reward distribution',
      actors: actors.slice(0, 5),
      transactionPlans: [],
      targetBlocks: 15
    },
    {
      name: 'Early Economy Formation',
      description: 'First transactions and liquidity creation',
      actors: actors.slice(0, 8),
      transactionPlans: [
        { from: actors[0], to: actors[5], amount: 2000n * 100_000_000n, fee: 5_000_000n, description: 'Mining rewards to trader', priority: 1 },
        { from: actors[1], to: actors[6], amount: 1500n * 100_000_000n, fee: 3_000_000n, description: 'Pool payout', priority: 1 },
        { from: actors[2], to: actors[3], amount: 1000n * 100_000_000n, fee: 10_000_000n, description: 'Miner to institutional', priority: 2 },
        { from: actors[5], to: actors[7], amount: 500n * 100_000_000n, fee: 2_000_000n, description: 'Trader arbitrage', priority: 1 }
      ],
      targetBlocks: 8
    },
    {
      name: 'Market Development',
      description: 'Complex trading patterns and fee market dynamics',
      actors: actors.slice(0, 10),
      transactionPlans: [
        { from: actors[3], to: actors[4], amount: 5000n * 100_000_000n, fee: 50_000_000n, description: 'Large institutional transfer', priority: 3 },
        { from: actors[6], to: actors[8], amount: 100n * 100_000_000n, fee: 1_000_000n, description: 'Bot to retail', priority: 1 },
        { from: actors[7], to: actors[9], amount: 250n * 100_000_000n, fee: 2_500_000n, description: 'Market maker spread', priority: 2 },
        { from: actors[5], to: actors[6], amount: 300n * 100_000_000n, fee: 1_500_000n, description: 'Trading pair liquidity', priority: 1 },
        { from: actors[8], to: actors[9], amount: 50n * 100_000_000n, fee: 500_000n, description: 'Retail payment', priority: 1 }
      ],
      targetBlocks: 10
    },
    {
      name: 'Mature Network Activity',
      description: 'High-throughput period with diverse transaction types',
      actors: actors,
      transactionPlans: [
        { from: actors[4], to: actors[10], amount: 1000n * 100_000_000n, fee: 25_000_000n, description: 'Treasury distribution', priority: 2 },
        { from: actors[9], to: actors[11], amount: 75n * 100_000_000n, fee: 750_000n, description: 'DeFi interaction', priority: 1 },
        { from: actors[10], to: actors[8], amount: 200n * 100_000_000n, fee: 2_000_000n, description: 'NFT purchase', priority: 2 },
        { from: actors[11], to: actors[6], amount: 25n * 100_000_000n, fee: 250_000n, description: 'Contract deployment fee', priority: 1 },
        { from: actors[6], to: actors[7], amount: 150n * 100_000_000n, fee: 1_000_000n, description: 'Arbitrage cycle', priority: 1 },
        { from: actors[8], to: actors[11], amount: 35n * 100_000_000n, fee: 350_000n, description: 'Retail to developer', priority: 1 }
      ],
      targetBlocks: 12
    }
  ];
}

async function executeEconomicScenario(
  blockchain: Blockchain,
  mempool: Mempool,
  scenario: EconomicScenario
) {
  printSectionHeader(`Scenario: ${scenario.name}`, scenario.description);
  
  // Update actor balances from blockchain
  for (const actor of scenario.actors) {
    actor.balance = await blockchain.getBalance(actor.address);
    actor.nonce = await blockchain.getNonce(actor.address);
  }
  
  // Display initial state
  const actorHeaders = ['Name', 'Role', 'Address', 'Balance', 'Activity'];
  const actorRows = scenario.actors.map(actor => [
    actor.name,
    actor.role.charAt(0).toUpperCase() + actor.role.slice(1),
    formatAddress(actor.address),
    formatWatts(actor.balance),
    actor.activity
  ]);
  printTable('Scenario Participants', actorHeaders, actorRows);
  
  // Mining phase
  if (scenario.targetBlocks > 0) {
    console.log(`\nPhase 1: Mining ${scenario.targetBlocks} blocks with different miners...`);
    
    const miners = scenario.actors.filter(actor => actor.role === 'miner');
    const minedBlocks = [];
    
    for (let i = 1; i <= scenario.targetBlocks; i++) {
      const minerIndex = (i - 1) % miners.length;
      const miner = miners[minerIndex];
      
      const template = await blockchain.createBlockTemplate([], miner.address);
      const block = new BlockClass(
        template.height,
        Date.now() + Math.random() * 2000, // Simulate network latency
        template.previousHash,
        template.transactions,
        template.difficulty,
        miner.address
      );
      
      const startTime = Date.now();
      const success = block.mine(devnet.hashAlgorithm);
      const mineTime = Date.now() - startTime;
      
      if (success) {
        const result = await blockchain.addBlock(block);
        if (result.valid) {
          const blockReward = blockchain.getBlockReward(block.index);
          
          // Record metrics
          recordBlockMined(
            devnet.name,
            miner.name,
            block.difficulty,
            mineTime,
            block.getSize(),
            blockReward,
            block.index
          );
          
          // Record coinbase transaction
          const coinbaseTx = block.getCoinbaseTransaction();
          if (coinbaseTx) {
            recordTransaction(devnet.name, 'coinbase', coinbaseTx.amount, 0n);
          }
          
          updateHashRate(block.difficulty, mineTime / 1000);
          
          minedBlocks.push({
            height: block.index,
            miner: miner.name,
            hash: block.hash,
            time: mineTime,
            reward: blockReward,
            transactions: block.transactions.length
          });
          
          console.log(`  Block ${block.index}: Mined by ${miner.name} in ${mineTime}ms (${formatWatts(blockReward)} reward)`);
          
          // Update miner balance
          miner.balance = await blockchain.getBalance(miner.address);
        }
      }
      
      // Small delay for realism
      await sleep(100 + Math.random() * 200);
    }
    
    // Display mining results
    const blockHeaders = ['Height', 'Miner', 'Hash', 'Time (ms)', 'Reward', 'TXs'];
    const blockRows = minedBlocks.map(block => [
      block.height.toString(),
      block.miner,
      formatHash(block.hash),
      block.time.toString(),
      formatWatts(block.reward),
      block.transactions.toString()
    ]);
    printTable('Mining Results', blockHeaders, blockRows);
  }
  
  // Transaction phase
  if (scenario.transactionPlans.length > 0) {
    console.log(`\nPhase 2: Processing ${scenario.transactionPlans.length} planned transactions...`);
    
    // Update balances before transactions
    for (const actor of scenario.actors) {
      actor.balance = await blockchain.getBalance(actor.address);
      actor.nonce = await blockchain.getNonce(actor.address);
    }
    
    // Sort by priority
    const sortedPlans = scenario.transactionPlans.sort((a, b) => b.priority - a.priority);
    const createdTransactions = [];
    
    for (const plan of sortedPlans) {
      try {
        // Check if sender has sufficient balance
        if (plan.from.balance >= plan.amount + plan.fee) {
          const signedTx = await createSignedTransaction(
            plan.from.address,
            plan.to.address,
            plan.amount,
            plan.from.nonce,
            plan.fee,
            plan.from.privateKey
          );
          
          await mempool.addTransaction(signedTx.toObject());
          
          recordTransaction(devnet.name, 'transfer', signedTx.amount, signedTx.fee);
          
          createdTransactions.push({
            hash: signedTx.hash,
            from: plan.from.name,
            to: plan.to.name,
            amount: plan.amount,
            fee: plan.fee,
            description: plan.description,
            priority: plan.priority
          });
          
          // Update local tracking
          plan.from.balance -= (plan.amount + plan.fee);
          plan.from.nonce++;
          
          console.log(`  ✓ ${plan.description}: ${formatWatts(plan.amount)} (fee: ${formatWatts(plan.fee)})`);
        } else {
          console.log(`  ✗ ${plan.description}: Insufficient balance (${formatWatts(plan.from.balance)} < ${formatWatts(plan.amount + plan.fee)})`);
        }
      } catch (error: any) {
        console.log(`  ✗ ${plan.description}: ${error.message}`);
      }
      
      await sleep(50);
    }
    
    // Display transaction results
    if (createdTransactions.length > 0) {
      const txHeaders = ['Priority', 'Description', 'From', 'To', 'Amount', 'Fee'];
      const txRows = createdTransactions.map(tx => [
        tx.priority.toString(),
        tx.description,
        tx.from,
        tx.to,
        formatWatts(tx.amount),
        formatWatts(tx.fee)
      ]);
      printTable('Created Transactions', txHeaders, txRows);
      
      // Update mempool metrics
      const mempoolStats = mempool.getStats();
      updateMempoolMetrics(mempoolStats.size, mempoolStats.bytes);
      
      // Mine block with transactions
      console.log(`\nMining consolidation block with ${createdTransactions.length} transactions...`);
      const consolidationMiner = scenario.actors.find(actor => actor.role === 'miner');
      if (consolidationMiner) {
        const txsToMine = mempool.getTransactionsForBlock();
        const template = await blockchain.createBlockTemplate(txsToMine, consolidationMiner.address);
        const block = new BlockClass(
          template.height,
          Date.now(),
          template.previousHash,
          template.transactions,
          template.difficulty,
          consolidationMiner.address
        );
        
        const success = block.mine(devnet.hashAlgorithm);
        if (success) {
          const result = await blockchain.addBlock(block);
          if (result.valid) {
            await mempool.removeBlockTransactions(txsToMine);
            const totalFees = txsToMine.reduce((sum, tx) => sum + tx.fee, 0n);
            console.log(`  ✓ Consolidation block ${block.index} mined by ${consolidationMiner.name}`);
            console.log(`    Transactions: ${block.transactions.length}, Total fees: ${formatWatts(totalFees)}`);
          }
        }
      }
    }
  }
  
  // Update final balances and record metrics
  for (const actor of scenario.actors) {
    actor.balance = await blockchain.getBalance(actor.address);
    actor.nonce = await blockchain.getNonce(actor.address);
    recordAccountBalance(actor.balance);
  }
  
  // Display final state
  const finalHeaders = ['Name', 'Role', 'Balance', 'Transactions', 'Status'];
  const finalRows = scenario.actors.map(actor => [
    actor.name,
    actor.role.charAt(0).toUpperCase() + actor.role.slice(1),
    formatWatts(actor.balance),
    actor.nonce.toString(),
    actor.balance > 0n ? 'Active' : 'Empty'
  ]);
  printTable('Final Account States', finalHeaders, finalRows);
  
  console.log(`\nScenario "${scenario.name}" completed successfully!`);
}

async function elaborateActivityDemo() {
  printSectionHeader('BOLT BLOCKCHAIN ELABORATE ACTIVITY DEMONSTRATION');
  
  try {
    // Initialize
    initializeMetrics();
    console.log('Advanced metrics collection initialized');
    
    const config = devnet;
    const storage = createStorage('redis');
    const blockchain = new Blockchain(storage, config);
    const mempool = new Mempool(storage);
    
    await blockchain.initialize();
    
    // Display network configuration
    const networkHeaders = ['Parameter', 'Value', 'Impact'];
    const networkRows = [
      ['Network Type', config.name, 'Development environment with rapid blocks'],
      ['Chain ID', config.chainId.toString(), 'Unique network identifier'],
      ['Block Time Target', `${config.targetBlockTime}s`, 'Fast confirmation for testing'],
      ['Initial Difficulty', config.initialDifficulty.toString(), 'Minimal PoW for rapid mining'],
      ['Block Reward', formatWatts(config.initialReward), 'High rewards for bootstrap incentives'],
      ['Max Supply', formatWatts(config.maxSupply), 'Bitcoin-like scarcity model'],
      ['Address Prefix', `0x${config.addressPrefix.toString(16)}`, 'Custom devnet addressing']
    ];
    printTable('Network Configuration', networkHeaders, networkRows);
    
    // Generate and execute economic scenarios
    const scenarios = generateEconomicScenarios();
    
    let totalBlocks = 0;
    let totalTransactions = 0;
    const startHeight = await blockchain.getHeight();
    
    for (let i = 0; i < scenarios.length; i++) {
      const scenario = scenarios[i];
      console.log(`\n${'◆'.repeat(5)} ECONOMIC SCENARIO ${i + 1}/${scenarios.length} ${'◆'.repeat(5)}`);
      
      await executeEconomicScenario(blockchain, mempool, scenario);
      
      totalBlocks += scenario.targetBlocks;
      totalTransactions += scenario.transactionPlans.length;
      
      // Brief pause between scenarios
      if (i < scenarios.length - 1) {
        console.log('\nPreparing next economic scenario...');
        await sleep(1000);
      }
    }
    
    // Final network analysis
    printSectionHeader('COMPREHENSIVE NETWORK ANALYSIS');
    
    const finalHeight = await blockchain.getHeight();
    const totalSupply = BigInt(finalHeight + 1 - startHeight) * config.initialReward;
    const cumulativeDifficulty = await blockchain.getCumulativeDifficulty();
    
    // Network statistics
    const networkStatsHeaders = ['Metric', 'Value', 'Analysis'];
    const networkStatsRows = [
      ['Total Blocks Processed', (finalHeight + 1 - startHeight).toString(), 'Network growth during demo'],
      ['Unique Addresses', scenarios[scenarios.length - 1].actors.length.toString(), 'Active participant count'],
      ['Total Supply Increase', formatWatts(totalSupply), 'New BOLT minted from mining'],
      ['Cumulative Difficulty', cumulativeDifficulty.toString(), 'Total proof-of-work secured'],
      ['Transaction Throughput', `${totalTransactions} txs`, 'Economic activity volume'],
      ['Average Block Size', '~650 bytes', 'Efficient block structure'],
      ['Network Hashrate', 'Variable', 'Adjusted for demonstration']
    ];
    printTable('Network Performance Statistics', networkStatsHeaders, networkStatsRows);
    
    // Economic distribution analysis
    const actors = scenarios[scenarios.length - 1].actors;
    const totalCirculatingSupply = actors.reduce((sum, actor) => sum + actor.balance, 0n);
    
    const distributionHeaders = ['Role', 'Participants', 'Total Balance', 'Avg Balance', 'Market Share'];
    const roleGroups = ['miner', 'whale', 'trader', 'retail'].map(role => {
      const roleActors = actors.filter(a => a.role === role);
      const totalBalance = roleActors.reduce((sum, actor) => sum + actor.balance, 0n);
      const avgBalance = roleActors.length > 0 ? totalBalance / BigInt(roleActors.length) : 0n;
      const marketShare = totalCirculatingSupply > 0n ? 
        Number(totalBalance * 10000n / totalCirculatingSupply) / 100 : 0;
      
      return [
        role.charAt(0).toUpperCase() + role.slice(1),
        roleActors.length.toString(),
        formatWatts(totalBalance),
        formatWatts(avgBalance),
        `${marketShare.toFixed(1)}%`
      ];
    });
    printTable('Economic Distribution by Role', distributionHeaders, roleGroups);
    
    // Update final chain metrics
    updateChainMetrics(finalHeight + 1, cumulativeDifficulty, totalCirculatingSupply, actors.length);
    
    // Monitoring information
    printSectionHeader('ADVANCED MONITORING & ANALYTICS');
    
    console.log('🎯 COMPREHENSIVE METRICS GENERATED:');
    console.log('  • Block production rates and mining efficiency');
    console.log('  • Transaction volume and fee market dynamics');
    console.log('  • Account balance distribution and wealth concentration');
    console.log('  • Network hash rate estimation and security metrics');
    console.log('  • Economic activity patterns across user roles');
    console.log('  • Storage performance and blockchain state size');
    
    console.log('\n📊 ADVANCED DASHBOARDS AVAILABLE:');
    console.log('  • Grafana: http://localhost:7340 (admin/admin)');
    console.log('  • Prometheus: http://localhost:7338');
    console.log('  • Bolt Metrics API: http://localhost:7336/metrics');
    
    console.log('\n🔍 SUGGESTED GRAFANA QUERIES:');
    console.log('  • rate(bolt_blocks_total[5m]) - Block production rate');
    console.log('  • bolt_transaction_amount_bolt_sum / bolt_transaction_amount_bolt_count - Avg tx size');
    console.log('  • histogram_quantile(0.95, bolt_block_mining_duration_seconds_bucket) - Mining P95');
    console.log('  • bolt_total_supply_bolt - Token supply evolution');
    console.log('  • bolt_mempool_size - Transaction backlog');
    
    await blockchain.close();
    
    printSectionHeader('ELABORATE ACTIVITY DEMONSTRATION COMPLETE');
    
    console.log(`\n🏆 SIMULATION RESULTS:`);
    console.log(`  • ${scenarios.length} economic scenarios executed`);
    console.log(`  • ${finalHeight + 1 - startHeight} blocks mined`);
    console.log(`  • ${totalTransactions} transactions processed`);
    console.log(`  • ${actors.length} unique addresses participated`);
    console.log(`  • ${formatWatts(totalCirculatingSupply)} in total circulation`);
    console.log(`\n✨ Advanced blockchain activity simulation completed successfully!`);
    console.log(`The BOLT network now has a rich transaction history and diverse economic activity.`);
    
  } catch (error: any) {
    console.error('\n❌ Elaborate activity demo failed:', error.message);
    logger.error('Demo error:', error);
    process.exit(1);
  }
}

// Run demo if called directly
if (import.meta.main) {
  elaborateActivityDemo();
}

export { elaborateActivityDemo };