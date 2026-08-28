import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LMDBManager } from '../../src/storage/lmdb-manager';

const directories: string[] = [];

async function temporary(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `bolt-${name}-`));
  directories.push(directory);
  return directory;
}

async function storage(command: string, source: string, destination?: string, network = 'devnet') {
  const process = Bun.spawn([
    'bun', 'run', 'scripts/storage.ts', command, source, ...(destination ? [destination] : [])
  ], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...Bun.env, BOLT_NETWORK: network },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('cold storage recovery', () => {
  it('verifies, snapshots, and restores identity and chain data', async () => {
    const data = await temporary('data');
    const parent = await temporary('backup-parent');
    const backup = join(parent, 'snapshot');
    const restoreParent = await temporary('restore-parent');
    const restored = join(restoreParent, 'data');

    expect((await storage('verify', data)).exitCode).toBe(0);
    const identity = await readFile(join(data, '.identity'), 'utf8');
    expect((await storage('backup', data, backup)).exitCode).toBe(0);
    expect((await storage('restore', backup, restored)).exitCode).toBe(0);
    expect(await readFile(join(restored, '.identity'), 'utf8')).toBe(identity);
    expect((await storage('verify', restored)).exitCode).toBe(0);
  });

  it('rejects wrong-chain restores without replacing destination', async () => {
    const data = await temporary('data');
    const parent = await temporary('backup-parent');
    const backup = join(parent, 'snapshot');
    const restored = await temporary('restore');

    expect((await storage('verify', data)).exitCode).toBe(0);
    expect((await storage('backup', data, backup)).exitCode).toBe(0);
    const result = await storage('restore', backup, restored, 'testnet');

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('another chain');
  });

  it('fails startup verification after cumulative work corruption', async () => {
    const data = await temporary('data');
    expect((await storage('verify', data)).exitCode).toBe(0);
    const manager = new LMDBManager({ path: join(data, 'lmdb') });
    manager.metadata.putSync('cumulativeDifficulty', '0');
    await manager.close();

    const result = await storage('verify', data);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Cumulative difficulty mismatch');
  });

  it('fails startup verification after account undo corruption', async () => {
    const data = await temporary('data');
    expect((await storage('verify', data)).exitCode).toBe(0);
    const manager = new LMDBManager({ path: join(data, 'lmdb') });
    const genesisHeight = Buffer.alloc(4);
    const genesisData = manager.blocks.get(genesisHeight)!;
    const genesis = JSON.parse(genesisData.toString());
    manager.accountChanges.putSync(genesis.hash, Buffer.from(JSON.stringify([{
      address: 'corrupt', previous: null, state: { balance: '1', nonce: 0 },
    }])));
    await manager.close();

    const result = await storage('verify', data);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('Invalid account undo');
  });
});
