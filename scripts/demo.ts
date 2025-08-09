#!/usr/bin/env bun

import { Blockchain } from '../src/core/blockchain';
import { Mempool } from '../src/core/mempool';
import { MiningService } from '../src/services/mining';
import { BlockClass } from '../src/core/block';
import { TransactionClass, createCoinbaseTransaction, createSignedTransaction } from '../src/core/transaction';
import { createStorage } from '../src/storage';
import { devnet } from '../src/config/chains/devnet';
import { calculateChainVersionHash } from '../src/config/chain';
import { generateAddress, validateAddress } from '../src/crypto/address';
import { formatWatts } from '../src/utils/currency';
import { getLogger } from '../src/utils/logger';

const logger = getLogger(__filename);

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function demo() {
  console.log('\n🚀 Bolt Blockchain Demo\n');
  
  try {
    // setup
    const config = devnet;
    const storage = createStorage('memory');
    const blockchain = new Blockchain(storage, config);
    const mempool = new Mempool(storage);
    
    // initialize blockchain
    await blockchain.initialize();
    console.log(`✅ Initialized ${config.name} blockchain`);
    
    // generate some test wallets using chain config prefix
    const miner1 = generateAddress(config.addressPrefix);
    const miner2 = generateAddress(config.addressPrefix);
    const alice = generateAddress(config.addressPrefix);
    const bob = generateAddress(config.addressPrefix);
    
    const miner1Address = miner1.address;
    const miner2Address = miner2.address;
    const aliceAddress = alice.address;
    const bobAddress = bob.address;
    
    console.log('\n👤 Generated wallets:');
    console.log(`   Miner 1: ${miner1Address}`);
    console.log(`   Miner 2: ${miner2Address}`);
    console.log(`   Alice:   ${aliceAddress}`);
    console.log(`   Bob:     ${bobAddress}`);
    
    // debug address validation
    console.log(`\n🔍 Address validation:`);
    console.log(`   Miner 1 valid: ${validateAddress(miner1Address)}`);
    console.log(`   Alice valid: ${validateAddress(aliceAddress)}`);
    
    // mine some initial blocks
    console.log('\n⛏️  Mining initial blocks...');
    
    for (let i = 1; i <= 3; i++) {
      const template = await blockchain.createBlockTemplate([], miner1Address);
      const block = new BlockClass(
        template.height,
        Date.now(),
        template.previousHash,
        template.transactions,
        template.difficulty,
        calculateChainVersionHash(config),
        miner1Address
      );
      
      console.log(`   Block ${i}: Mining with difficulty ${template.difficulty}...`);
      const success = block.mine(config.hashAlgorithm);
      
      if (success) {
        const result = await blockchain.addBlock(block);
        if (result.valid) {
          console.log(`   Block ${i}: ✅ Mined successfully (hash: ${block.hash.slice(0, 16)}...)`);
        } else {
          console.log(`   Block ${i}: ❌ Rejected: ${result.error}`);
        }
      } else {
        console.log(`   Block ${i}: ❌ Mining failed`);
      }
      
      await sleep(100);
    }
    
    // check miner balance
    const miner1Balance = await blockchain.getBalance(miner1Address);
    console.log(`\n💰 Miner 1 balance: ${formatWatts(miner1Balance)}`);
    
    // create and sign some transactions  
    console.log('\n💸 Creating transactions...');
    
    try {
      // send some coins to alice
      const signedTx1 = await createSignedTransaction(
        miner1Address,
        aliceAddress,
        1000000000n, // 10 BOLT
        0, // nonce
        100000n, // 0.001 BOLT fee
        miner1.privateKey
      );
      
      console.log('Transaction created, checking size...');
      const txObj = signedTx1.toObject();
      console.log('Transaction object created, adding to mempool...');
      
      await mempool.addTransaction(txObj);
      console.log(`   Tx 1: ${miner1Address.slice(0, 10)}... → ${aliceAddress.slice(0, 10)}... (10 BOLT)`);
      
    } catch (error) {
      console.error('Failed to create transaction:', error);
      // continue with empty mempool
    }
    
    // mine a block with whatever transactions we have
    console.log('\n⛏️  Mining block with transactions...');
    const txs = mempool.getTransactionsForBlock();
    console.log(`Got ${txs.length} transactions from mempool`);
    const template = await blockchain.createBlockTemplate(txs, miner2Address);
    
    const block = new BlockClass(
      template.height,
      Date.now(),
      template.previousHash,
      template.transactions,
      template.difficulty,
      config.name,
      miner2Address
    );
    
    console.log(`   Mining block ${template.height} with ${txs.length} transactions...`);
    const success = block.mine(config.hashAlgorithm);
    
    if (success) {
      const result = await blockchain.addBlock(block);
      if (result.valid) {
        console.log(`   ✅ Block mined successfully (hash: ${block.hash.slice(0, 16)}...)`);
        await mempool.removeBlockTransactions(txs);
      } else {
        console.log(`   ❌ Block rejected: ${result.error}`);
      }
    } else {
      console.log(`   ❌ Mining failed`);
    }
    
    // show final balances
    console.log('\n💰 Final balances:');
    const finalMiner1Balance = await blockchain.getBalance(miner1Address);
    const finalMiner2Balance = await blockchain.getBalance(miner2Address);
    const aliceBalance = await blockchain.getBalance(aliceAddress);
    const bobBalance = await blockchain.getBalance(bobAddress);
    
    console.log(`   Miner 1: ${formatWatts(finalMiner1Balance)}`);
    console.log(`   Miner 2: ${formatWatts(finalMiner2Balance)}`);
    console.log(`   Alice:   ${formatWatts(aliceBalance)}`);
    console.log(`   Bob:     ${formatWatts(bobBalance)}`);
    
    // show blockchain stats
    console.log('\n📊 Blockchain stats:');
    const height = await blockchain.getHeight();
    const difficulty = await blockchain.getDifficulty();
    const cumulative = await blockchain.getCumulativeDifficulty();
    
    console.log(`   Height: ${height + 1} blocks`);
    console.log(`   Current difficulty: ${difficulty}`);
    console.log(`   Cumulative difficulty: ${cumulative}`);
    
    // show recent blocks
    console.log('\n🧱 Recent blocks:');
    for (let i = Math.max(0, height - 2); i <= height; i++) {
      const block = await blockchain.getBlock(i);
      if (block) {
        console.log(`   Block ${block.index}: ${block.hash.slice(0, 16)}... (${block.transactions.length} txs, diff: ${block.difficulty})`);
      }
    }
    
    console.log('\n✨ Demo completed successfully!\n');
    
    // verify chain integrity
    console.log('🔍 Verifying chain integrity...');
    const integrity = await blockchain.verifyChainIntegrity();
    if (integrity.valid) {
      console.log('   ✅ Chain integrity verified');
    } else {
      console.log(`   ❌ Chain integrity failed: ${integrity.error}`);
    }
    
    await blockchain.close();
    console.log('\n👋 Blockchain closed\n');
    
  } catch (error: any) {
    console.error('\n❌ Demo failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// run demo if called directly
if (import.meta.main) {
  demo();
}

export { demo };