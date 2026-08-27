import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IdentityManager } from '../../src/utils/identity';
import { validateAddress } from '../../src/crypto/address';

describe('node identity', () => {
  it('uses active network prefix and real signatures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bolt-identity-'));
    try {
      const manager = new IdentityManager(directory, 0xef);
      const identity = await manager.loadOrCreate();
      const message = new TextEncoder().encode('bolt peer identity');
      const signature = await manager.sign(message);
      await chmod(join(directory, '.identity'), 0o644);
      const restored = await new IdentityManager(directory, 0xef).loadOrCreate();

      expect(validateAddress(identity.address, 0xef)).toBe(true);
      expect(restored).toEqual(identity);
      expect((await stat(join(directory, '.identity'))).mode & 0o777).toBe(0o600);
      expect(await manager.verify(message, signature, identity.publicKey)).toBe(true);
      expect(await manager.verify(new Uint8Array([0]), signature, identity.publicKey)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when stored identity does not match active network', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bolt-identity-'));
    try {
      const mainnet = new IdentityManager(directory, 0x00);
      await mainnet.loadOrCreate();

      await expect(new IdentityManager(directory, 0xef).loadOrCreate()).rejects.toThrow('active network');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves identity when an interrupted temporary write remains', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bolt-identity-'));
    try {
      const identity = await new IdentityManager(directory, 0xef).loadOrCreate();
      await writeFile(join(directory, '.identity.interrupted.tmp'), '{');

      const restored = await new IdentityManager(directory, 0xef).loadOrCreate();

      expect(restored).toEqual(identity);
      expect(JSON.parse(await readFile(join(directory, '.identity'), 'utf8'))).toEqual(identity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
