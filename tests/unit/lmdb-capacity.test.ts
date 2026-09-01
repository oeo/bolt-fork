import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LMDBAdapter } from '../../src/storage/lmdb-adapter';

test('reports LMDB growth beyond its initial map size', async () => {
  const path = join(tmpdir(), `bolt-lmdb-capacity-${randomUUID()}`);
  const mapSize = 8 * 1024 * 1024;
  const storage = new LMDBAdapter({ path, mapSize });
  await storage.connect();
  try {
    const payload = randomBytes(512 * 1024).toString('hex');
    for (let index = 0; index < 16; index++) await storage.setCustomData(`fill:${index}`, payload);

    const stats = await storage.getStats();
    expect(stats.initialMapSize).toBe(mapSize);
    expect(stats.used).toBeGreaterThan(mapSize);
    expect(stats.mappedSize).toBeGreaterThanOrEqual(stats.used);
    expect(stats.headroom).toBe(stats.mappedSize - stats.used);
  } finally {
    await storage.close();
    await rm(path, { recursive: true, force: true });
  }
});

test('opens existing LMDB state read-only', async () => {
  const path = join(tmpdir(), `bolt-lmdb-readonly-${randomUUID()}`);
  let storage = new LMDBAdapter({ path, mapSize: 8 * 1024 * 1024 });
  await storage.connect();
  await storage.setCustomData('proof', 'stored');
  await storage.close();

  storage = new LMDBAdapter({ path, mapSize: 8 * 1024 * 1024, readOnly: true });
  await storage.connect();
  try {
    expect((await storage.getCustomData('proof'))?.toString()).toBe('stored');
    await expect(storage.setCustomData('proof', 'changed')).rejects.toBeDefined();
  } finally {
    await storage.close();
    await rm(path, { recursive: true, force: true });
  }
});
