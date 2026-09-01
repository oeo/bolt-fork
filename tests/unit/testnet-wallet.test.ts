import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAmount } from '../../examples/testnet-wallet/amount';
import { createKeystore, openKeystore } from '../../examples/testnet-wallet/keystore';

const paths: string[] = [];
afterEach(async () => Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe('testnet wallet', () => {
  it('parses explicit BOLT and watt amounts without guessing', () => {
    expect(parseAmount('1')).toBe(100_000_000n);
    expect(parseAmount('1.00000001')).toBe(100_000_001n);
    expect(parseAmount('42w')).toBe(42n);
    expect(() => parseAmount('1.000000001')).toThrow();
    expect(() => parseAmount('1e2')).toThrow();
    expect(() => parseAmount('-1')).toThrow();
  });

  it('encrypts mnemonic and authenticates chain metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bolt-wallet-'));
    paths.push(directory);
    const path = join(directory, 'wallet.json');
    const identity = { chainId: 1058, genesisHash: 'ab'.repeat(32), addressPrefix: 0x6f, path: "m/44'/1057'/0'/0/0" };
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    await createKeystore(path, mnemonic, 'correct horse battery staple', identity);
    expect(await openKeystore(path, 'correct horse battery staple')).toEqual({ mnemonic, identity });
    expect(await readFile(path, 'utf8')).not.toContain(mnemonic);
    await expect(openKeystore(path, 'wrong password value')).rejects.toThrow('Invalid password');

    const file = JSON.parse(await readFile(path, 'utf8'));
    file.chainId = 9999;
    await writeFile(path, JSON.stringify(file));
    await expect(openKeystore(path, 'correct horse battery staple')).rejects.toThrow('corrupted');
  });
});
