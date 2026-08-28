import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Block } from '../../src/types';
import { LMDBAdapter } from '../../src/storage/lmdb-adapter';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('lmdb crash atomicity', () => {
  it('recovers wholly before or after a SIGKILL at transition boundary', async () => {
    const path = await mkdtemp(join(tmpdir(), 'bolt-lmdb-crash-'));
    directories.push(path);
    const marker = join(path, 'boundary');
    const genesis = block(0, '0'.repeat(64), 'a'.repeat(64));
    const next = block(1, genesis.hash, 'b'.repeat(64));
    let storage = new LMDBAdapter({ path, mapSize: 64 * 1024 * 1024 });
    await storage.connect();
    await storage.transitionCanonicalChain({
      expectedTip: { height: -1, hash: null },
      expectedCumulativeDifficulty: 0n,
      ancestor: { height: -1, hash: null },
      blocks: [genesis],
      accountChanges: [{ blockHash: genesis.hash, changes: [] }],
      cumulativeDifficulty: 1n,
      mempoolAdditions: [],
      mempoolRemovals: [],
    });
    await storage.close();

    const child = Bun.spawn(['bun', '-e', `
      import { LMDBAdapter } from './src/storage/lmdb-adapter.ts';
      const storage = new LMDBAdapter({ path: ${JSON.stringify(path)}, mapSize: 64 * 1024 * 1024 });
      await storage.connect();
      const changes = Array.from({ length: 10000 }, (_, index) => ({
        address: 'account-' + index,
        previous: null,
        state: { balance: BigInt(index + 1), nonce: 0 },
      }));
      await Bun.write(${JSON.stringify(marker)}, 'ready');
      await storage.transitionCanonicalChain({
        expectedTip: { height: 0, hash: '${genesis.hash}' },
        expectedCumulativeDifficulty: 1n,
        ancestor: { height: 0, hash: '${genesis.hash}' },
        blocks: [${JSON.stringify(next)}],
        accountChanges: [{ blockHash: '${next.hash}', changes }],
        cumulativeDifficulty: 2n,
        mempoolAdditions: [],
        mempoolRemovals: [],
      });
      await storage.close();
    `], { cwd: join(import.meta.dir, '../..'), stdout: 'ignore', stderr: 'ignore' });

    for (let attempts = 0; attempts < 200 && !existsSync(marker); attempts++) await Bun.sleep(5);
    expect(existsSync(marker)).toBe(true);
    child.kill(9);
    await child.exited;

    storage = new LMDBAdapter({ path, mapSize: 64 * 1024 * 1024 });
    await storage.connect();
    const tip = await storage.getLatestBlock();
    expect([genesis.hash, next.hash]).toContain(tip?.hash);
    const addresses = await storage.getAllAccountAddresses();
    if (tip?.hash === genesis.hash) {
      expect(addresses).toHaveLength(0);
    } else {
      expect(addresses).toHaveLength(10000);
      expect(await storage.getAccountState('account-9999')).toEqual({ balance: 10000n, nonce: 0 });
    }
    await storage.close();
  });
});

function block(index: number, previousHash: string, hash: string): Block {
  return {
    index,
    previousHash,
    hash,
    timestamp: index + 1,
    merkleRoot: '1'.repeat(64),
    stateRoot: '2'.repeat(64),
    difficulty: 1,
    nonce: 0,
    transactions: [],
  };
}
