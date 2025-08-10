import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ApiServer } from '../../src/api/server';
import { Blockchain } from '../../src/core/blockchain';
import { Mempool } from '../../src/core/mempool';
import { createStorage } from '../../src/storage';
import { config as chainConfig } from '../../src/config/chain';
import { generateAddress } from '../../src/crypto/address';
import { TransactionClass } from '../../src/core/transaction';
import { serialize } from '../../src/utils/bigint';

describe('API Server Integration', () => {
  let apiServer: ApiServer;
  let blockchain: Blockchain;
  let mempool: Mempool;
  let storage: any;

  beforeAll(async () => {
    // create storage
    storage = createStorage('memory');

    // create blockchain
    blockchain = new Blockchain(storage, chainConfig);
    await blockchain.initialize();

    // create mempool
    mempool = new Mempool(storage, chainConfig);

    // create api server WITHOUT p2p node
    apiServer = new ApiServer({
      port: 17333, // test port
      blockchain,
      mempool,
      storage
      // note: no node provided
    });

    // start api server
    await apiServer.start();
  });

  afterAll(async () => {
    await apiServer.stop();
    await storage.close();
  });

  test('should expose health endpoint', async () => {
    const response = await fetch('http://localhost:17333/health');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
  });

  test('should get blockchain info', async () => {
    const response = await fetch('http://localhost:17333/blockchain/info');
    expect(response.status).toBe(200);
    const info = await response.json();
    
    expect(info.network).toBe(chainConfig.name);
    expect(info.height).toBe(0); // genesis only
    expect(info.difficulty).toBeDefined();
    expect(info.targetBlockTime).toBe(chainConfig.targetBlockTime);
    expect(info.maxSupply).toContain('BOLT');
    expect(info.currentReward).toContain('BOLT');
  });

  test('should get blocks', async () => {
    const response = await fetch('http://localhost:17333/blocks?limit=5');
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.blocks).toBeInstanceOf(Array);
    expect(data.blocks.length).toBe(1); // only genesis
    expect(data.total).toBe(1);
    expect(data.limit).toBe(5);
    expect(data.offset).toBe(0);
  });

  test('should get specific block by height', async () => {
    const response = await fetch('http://localhost:17333/blocks/0');
    expect(response.status).toBe(200);
    const block = await response.json();
    
    expect(block.index).toBe(0);
    expect(block.previousHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
    expect(block.transactions).toBeInstanceOf(Array);
  });

  test('should handle non-existent block', async () => {
    const response = await fetch('http://localhost:17333/blocks/999');
    expect(response.status).toBe(500);
    const error = await response.json();
    expect(error.error).toContain('Block not found');
  });

  test('should get mempool info', async () => {
    const response = await fetch('http://localhost:17333/mempool');
    expect(response.status).toBe(200);
    const mempoolInfo = await response.json();
    
    expect(mempoolInfo.size).toBe(0);
    expect(mempoolInfo.bytes).toBe(0);
    expect(mempoolInfo.minFeePerByte).toBeDefined();
    expect(mempoolInfo.totalFees).toBeDefined();
  });

  test('should submit valid transaction', async () => {
    // create test accounts
    const alice = generateAddress();
    const bob = generateAddress();
    
    // give alice some balance
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n, // 100 BOLT
      nonce: 0
    });

    // create transaction (from, to, amount, nonce, fee, timestamp)
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n, // 10 BOLT amount
      0, // nonce
      1_000_000n, // 0.01 BOLT fee
      Date.now()
    );
    await tx.sign(alice.privateKey);

    // submit via API
    const response = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(tx.toObject())
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.accepted).toBe(true);
    expect(result.hash).toBe(tx.hash);
    expect(result.broadcasted).toBe(false); // no p2p node

    // verify in mempool
    const mempoolTx = mempool.getTransaction(tx.hash);
    expect(mempoolTx).toBeDefined();
    expect(mempoolTx?.hash).toBe(tx.hash);
  });

  test('should reject invalid transaction', async () => {
    const alice = generateAddress();
    const bob = generateAddress();
    
    // alice has no balance
    const tx = new TransactionClass(
      alice.address,
      bob.address,
      1_000_000_000n, // amount
      0, // nonce
      1_000_000n, // fee
      Date.now()
    );
    await tx.sign(alice.privateKey);

    const response = await fetch('http://localhost:17333/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(tx.toObject())
    });

    expect(response.status).toBe(500);
    const error = await response.json();
    expect(error.error).toContain('Insufficient balance');
  });

  test('should get account balance', async () => {
    const alice = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 5_000_000_000n, // 50 BOLT
      nonce: 2
    });

    const response = await fetch(`http://localhost:17333/accounts/${alice.address}/balance`);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.address).toBe(alice.address);
    expect(data.balance).toBe('5000000000n');
    expect(data.formatted).toBe('50 BOLT');
  });

  test('should get account nonce', async () => {
    const alice = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 1_000_000_000n,
      nonce: 5
    });

    const response = await fetch(`http://localhost:17333/accounts/${alice.address}/nonce`);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.address).toBe(alice.address);
    expect(data.nonce).toBe(5);
  });

  test('should get transaction by hash', async () => {
    // add a transaction to mempool
    const alice = generateAddress();
    const bob = generateAddress();
    
    await storage.updateAccountState(alice.address, {
      balance: 10_000_000_000n,
      nonce: 0
    });

    const tx = new TransactionClass(
      alice.address,
      bob.address,
      100_000_000n, // 1 BOLT amount
      0, // nonce
      100_000n, // fee
      Date.now()
    );
    await tx.sign(alice.privateKey);
    
    await mempool.addTransaction(tx.toObject());

    const response = await fetch(`http://localhost:17333/transactions/${tx.hash}`);
    expect(response.status).toBe(200);
    const data = await response.json();
    
    expect(data.hash).toBe(tx.hash);
    expect(data.status).toBe('pending');
    expect(data.confirmations).toBe(0);
  });

  test('should handle CORS headers', async () => {
    const response = await fetch('http://localhost:17333/health');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  test('should handle OPTIONS requests', async () => {
    const response = await fetch('http://localhost:17333/health', {
      method: 'OPTIONS'
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('should return 404 for unknown endpoints', async () => {
    const response = await fetch('http://localhost:17333/unknown');
    expect(response.status).toBe(404);
    const error = await response.json();
    expect(error.error).toBe('Endpoint not found');
  });

  test('should handle network status without p2p node', async () => {
    const response = await fetch('http://localhost:17333/network/status');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.error).toBe('Network node not available');
  });

  test('should handle peers endpoint without p2p node', async () => {
    const response = await fetch('http://localhost:17333/peers');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.error).toBe('Network node not available');
  });
});