import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BlockClass } from '../src/core/block';
import { Blockchain } from '../src/core/blockchain';
import { createCoinbaseTransaction } from '../src/core/transaction';
import { devnet } from '../src/config/chains/devnet';
import { generateFromPrivateKey } from '../src/crypto/address';
import { createStorage, type StorageType } from '../src/storage';

process.env.LOG_LEVEL = 'error';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const blockCount = Number(args.get('--blocks') || 10_000);
const storageType = (args.get('--storage') || 'memory') as StorageType;
if (!Number.isSafeInteger(blockCount) || blockCount < 1) throw new Error('Invalid --blocks');
if (storageType !== 'memory' && storageType !== 'lmdb') throw new Error('Invalid --storage');

const configuredPath = args.get('--path');
if (configuredPath) {
  const entries = await readdir(resolve(configuredPath)).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  if (entries.length > 0) throw new Error('--path must be empty');
}
const temporaryPath = storageType === 'lmdb' && !configuredPath
  ? await mkdtemp(join(tmpdir(), 'bolt-chain-benchmark-'))
  : null;
const storagePath = configuredPath ? resolve(configuredPath) : temporaryPath;
const storage = storageType === 'lmdb'
  ? createStorage({ type: 'lmdb', path: storagePath!, mapSize: Number(args.get('--map-size') || 100 * 1024 * 1024 * 1024) })
  : createStorage('memory');
const config = { ...devnet, difficultyAdjustmentInterval: 1_000_000_000 };
const chain = new Blockchain(storage, config);

try {
  await chain.initialize();
  const miner = generateFromPrivateKey('0'.repeat(63) + '1', config.addressPrefix).address;
  let previous = (await chain.getLatestBlock())!;
  const started = performance.now();

  for (let height = 1; height <= blockCount; height++) {
    const timestamp = config.genesisTimestamp + height * config.targetBlockTime * 1_000;
    const block = new BlockClass(height, timestamp, previous.hash, [
      createCoinbaseTransaction(config.chainId, miner, chain.getBlockReward(height), 0n, timestamp),
    ], 1, miner);
    await chain.prepareBlock(block);
    block.mine();
    const result = await chain.addBlock(block);
    if (!result.valid) throw new Error(`Block ${height}: ${result.error}`);
    previous = block;
  }

  const elapsedSeconds = (performance.now() - started) / 1_000;
  const memory = process.memoryUsage();
  console.log(JSON.stringify({
    blocks: blockCount,
    storage: storageType,
    elapsedSeconds,
    blocksPerSecond: blockCount / elapsedSeconds,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    storageStats: await storage.getStorageStats(),
  }));
} finally {
  await chain.close();
  if (temporaryPath) await rm(temporaryPath, { recursive: true, force: true });
}
