import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockClass } from '../../src/core/block';
import { Blockchain } from '../../src/core/blockchain';
import { createCoinbaseTransaction } from '../../src/core/transaction';
import { devnet } from '../../src/config/chains/devnet';
import { generateAddress } from '../../src/crypto/address';
import type { StorageAdapter } from '../../src/storage/adapter';
import { LMDBAdapter } from '../../src/storage/lmdb-adapter';
import { MemoryAdapter } from '../../src/storage/memory';

const config = { ...devnet, difficultyAdjustmentInterval: 1_000_000 };

function reorgRetryContract(name: string, create: () => Promise<{ storage: StorageAdapter; cleanup: () => Promise<void> }>): void {
  describe(name, () => {
    let cleanup: () => Promise<void>;

    afterEach(async () => cleanup?.());

    test('accepts an exact retry without changing canonical state', async () => {
      const created = await create();
      cleanup = created.cleanup;
      const chain = new Blockchain(created.storage, config);
      await chain.initialize();
      const genesis = (await chain.getBlock(0))!;
      const canonicalMiner = generateAddress(config.addressPrefix).address;
      const forkMiner = generateAddress(config.addressPrefix).address;
      const canonicalTime = genesis.timestamp + 1_000;
      const canonical = new BlockClass(1, canonicalTime, genesis.hash, [
        createCoinbaseTransaction(config.chainId, canonicalMiner, config.initialReward, 0n, canonicalTime),
      ], 1, canonicalMiner);
      await chain.prepareBlock(canonical);
      canonical.mine();
      expect((await chain.addBlock(canonical)).valid).toBe(true);

      const fork: BlockClass[] = [];
      let previous = genesis.hash;
      let parentStateRoot = genesis.stateRoot;
      let states = new Map<string, { balance: bigint; nonce: number }>();
      for (let height = 1; height <= 2; height++) {
        const timestamp = genesis.timestamp + height * 2_000;
        const block = new BlockClass(height, timestamp, previous, [
          createCoinbaseTransaction(config.chainId, forkMiner, config.initialReward, 0n, timestamp),
        ], 1, forkMiner);
        states = await chain.prepareBlock(block, states, parentStateRoot);
        block.mine();
        fork.push(block);
        previous = block.hash;
        parentStateRoot = block.stateRoot;
      }

      const replacement = fork.map(block => block.toObject());
      expect(await chain.reorganize(0, replacement)).toBe(true);
      const before = {
        tip: (await chain.getLatestBlock())!.hash,
        work: await chain.getCumulativeDifficulty(),
        balance: await chain.getBalance(forkMiner),
      };

      expect(await chain.reorganize(0, replacement)).toBe(true);
      expect((await chain.getLatestBlock())!.hash).toBe(before.tip);
      expect(await chain.getCumulativeDifficulty()).toBe(before.work);
      expect(await chain.getBalance(forkMiner)).toBe(before.balance);
      expect(await chain.reorganize(0, replacement.slice(1))).toBe(false);
    });
  });
}

reorgRetryContract('memory reorg retry', async () => {
  const storage = new MemoryAdapter();
  return { storage, cleanup: () => storage.close() };
});

reorgRetryContract('lmdb reorg retry', async () => {
  const path = join(tmpdir(), `bolt-reorg-retry-${randomUUID()}`);
  const storage = new LMDBAdapter({ path, mapSize: 64 * 1024 * 1024 });
  return {
    storage,
    cleanup: async () => {
      await storage.close();
      await rm(path, { recursive: true, force: true });
    },
  };
});
