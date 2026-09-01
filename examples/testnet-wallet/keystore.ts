import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ITERATIONS = 600_000;

export interface KeystoreIdentity {
  chainId: number;
  genesisHash: string;
  addressPrefix: number;
  path: string;
}

interface KeystoreFile extends KeystoreIdentity {
  version: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  ciphertext: string;
}

export async function createKeystore(
  path: string,
  mnemonic: string,
  password: string,
  identity: KeystoreIdentity
): Promise<void> {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const aad = metadata(identity);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(mnemonic)
  );
  const file: KeystoreFile = {
    version: 1,
    kdf: 'pbkdf2-sha256',
    iterations: ITERATIONS,
    cipher: 'aes-256-gcm',
    ...identity,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(ciphertext).toString('base64'),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(file, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function openKeystore(path: string, password: string): Promise<{
  mnemonic: string;
  identity: KeystoreIdentity;
}> {
  const fileStat = await lstat(path);
  if (fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0) throw new Error('Unsafe keystore permissions');
  const file = JSON.parse(await readFile(path, 'utf8')) as KeystoreFile;
  if (file.version !== 1 || file.kdf !== 'pbkdf2-sha256' || file.cipher !== 'aes-256-gcm' ||
      !Number.isSafeInteger(file.iterations) || file.iterations < ITERATIONS) {
    throw new Error('Unsupported keystore');
  }
  const identity = {
    chainId: file.chainId,
    genesisHash: file.genesisHash,
    addressPrefix: file.addressPrefix,
    path: file.path,
  };
  try {
    const key = await deriveKey(password, Buffer.from(file.salt, 'base64'), file.iterations);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: Buffer.from(file.iv, 'base64'),
      additionalData: metadata(identity),
    }, key, Buffer.from(file.ciphertext, 'base64'));
    return { mnemonic: new TextDecoder().decode(plaintext), identity };
  } catch {
    throw new Error('Invalid password or corrupted keystore');
  }
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, {
    name: 'AES-GCM', length: 256
  }, false, ['encrypt', 'decrypt']);
}

function metadata(identity: KeystoreIdentity): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(identity));
}
