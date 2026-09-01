import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FaucetDatabase } from '../../apps/testnet-faucet/database';

const paths: string[] = [];
afterEach(async () => Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))));

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'bolt-faucet-'));
  paths.push(directory);
  return new FaucetDatabase(join(directory, 'faucet.sqlite'));
}

describe('testnet faucet database', () => {
  it('enforces address, IP, queue, and global payout bounds durably', async () => {
    const store = await database();
    const now = Date.now();
    const create = (address: string, ipHash: string, amount = 100n) => store.createClaim({
      address, ipHash, amount, now, cooldownMs: 1000, windowMs: 10_000, globalBudget: 200n, capacity: 2
    });

    const first = create('address-a', 'ip-a');
    expect(store.get(first.id)?.status).toBe('queued');
    expect(() => create('address-a', 'ip-b')).toThrow('Address cooldown');
    expect(() => create('address-b', 'ip-a')).toThrow('IP cooldown');
    create('address-b', 'ip-b');
    expect(() => create('address-c', 'ip-c')).toThrow('queue');
    store.close();
  });

  it('preserves exact prepared payload for restart recovery', async () => {
    const store = await database();
    const claim = store.createClaim({
      address: 'address-a', ipHash: 'ip-a', amount: 100n, now: Date.now(),
      cooldownMs: 1000, windowMs: 10_000, globalBudget: 200n, capacity: 2
    });
    store.prepare(claim.id, 4, 'ab'.repeat(32), '{"signed":true}');

    expect(store.nextWork()).toMatchObject({
      id: claim.id, status: 'prepared', nonce: 4, transactionHash: 'ab'.repeat(32), payload: '{"signed":true}'
    });
    store.close();
  });
});
