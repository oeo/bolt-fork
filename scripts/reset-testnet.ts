import { rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { processIdentityIsRunning, type ProcessIdentity } from '../src/utils/pid';

const dataDir = resolve(process.argv[2] || './data');
if (process.argv[3] !== '--confirm-reset-testnet') {
  throw new Error('Usage: bun run reset:testnet DATA_DIR --confirm-reset-testnet');
}

try {
  const identity = JSON.parse(await readFile(join(dataDir, 'node.pid'), 'utf8')) as ProcessIdentity;
  if (processIdentityIsRunning(identity)) throw new Error(`Node is running as process ${identity.pid}`);
} catch (error: any) {
  if (error?.code !== 'ENOENT' && !String(error?.message).includes('Node is running')) throw error;
  if (String(error?.message).includes('Node is running')) throw error;
}

await rm(join(dataDir, 'lmdb'), { recursive: true, force: true });
await rm(join(dataDir, 'node.pid'), { force: true });
console.log(`Cleared testnet chain state in ${dataDir}; node identity preserved.`);
