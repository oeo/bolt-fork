import { cp, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Blockchain } from '../src/core/blockchain';
import { config } from '../src/config/chain';
import { createStorage } from '../src/storage';
import { LMDBManager } from '../src/storage/lmdb-manager';
import { processIdentityIsRunning, type ProcessIdentity } from '../src/utils/pid';
import { IdentityManager } from '../src/utils/identity';

interface BackupManifest {
  format: 1;
  chainId: number;
  network: string;
  createdAt: string;
}

async function assertStopped(dataDir: string): Promise<void> {
  try {
    const identity = JSON.parse(await readFile(join(dataDir, 'node.pid'), 'utf8')) as ProcessIdentity;
    if (processIdentityIsRunning(identity)) throw new Error(`node process ${identity.pid} is still running`);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertEmpty(path: string): Promise<void> {
  try {
    if ((await Array.fromAsync(new Bun.Glob('*').scan({ cwd: path, dot: true }))).length > 0) {
      throw new Error(`restore destination is not empty: ${path}`);
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function verify(dataDir: string): Promise<void> {
  await assertStopped(dataDir);
  new IdentityManager(dataDir, config.addressPrefix).loadExisting();
  const lmdbPath = join(dataDir, 'lmdb');
  await stat(lmdbPath);
  if ((await Array.fromAsync(new Bun.Glob('*').scan({ cwd: lmdbPath, dot: true }))).length === 0) {
    throw new Error(`lmdb store is empty: ${lmdbPath}`);
  }
  const storage = createStorage({ type: 'lmdb', path: lmdbPath, readOnly: true });
  try {
    const blockchain = new Blockchain(storage, config);
    await blockchain.initialize();
  } finally {
    await storage.close();
  }
}

async function backup(dataDir: string, destination: string): Promise<void> {
  await assertStopped(dataDir);
  await stat(destination).then(
    () => { throw new Error(`backup destination already exists: ${destination}`); },
    error => { if (error?.code !== 'ENOENT') throw error; }
  );
  const stage = `${destination}.stage-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  try {
    await mkdir(stage, { recursive: true });
    await mkdir(join(stage, 'lmdb'));
    const manager = new LMDBManager({ path: join(dataDir, 'lmdb') });
    try {
      await manager.backup(join(stage, 'lmdb'));
    } finally {
      await manager.close();
    }
    await cp(join(dataDir, '.identity'), join(stage, '.identity'));
    const manifest: BackupManifest = { format: 1, chainId: config.chainId, network: config.name, createdAt: new Date().toISOString() };
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const directory = await open(stage, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await rename(stage, destination);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function restore(source: string, destination: string): Promise<void> {
  await assertEmpty(destination);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as BackupManifest;
  if (manifest.format !== 1 || manifest.chainId !== config.chainId || manifest.network !== config.name) {
    throw new Error('backup belongs to another chain');
  }
  const stage = join(dirname(destination), `.${resolve(destination).split('/').at(-1)}.restore-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    await cp(join(source, 'lmdb'), join(stage, 'lmdb'), { recursive: true });
    await cp(join(source, '.identity'), join(stage, '.identity'));
    await verify(stage);
    await rm(destination, { recursive: true, force: true });
    await rename(stage, destination);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

const [command, rawDataDir, rawDestination] = process.argv.slice(2);
if (!command || !rawDataDir) throw new Error('usage: bun run storage <verify|backup|restore> <data-dir|backup> [destination]');
const first = resolve(rawDataDir);
if (command === 'verify') await verify(first);
else if (command === 'backup' && rawDestination) await backup(first, resolve(rawDestination));
else if (command === 'restore' && rawDestination) await restore(first, resolve(rawDestination));
else throw new Error('invalid storage command or missing destination');

console.log(`${command} complete`);
process.exit(0);
