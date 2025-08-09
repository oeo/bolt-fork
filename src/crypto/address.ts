import * as crypto from 'crypto';
import * as bip39 from 'bip39';
import * as hdkey from 'hdkey';
import { ec as EC } from 'elliptic';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { getLogger } from '../utils/logger';
import { BIP44_PURPOSE, BOLT_COIN_TYPE } from '../constants';

const logger = getLogger(__filename);
const secp256k1 = new EC('secp256k1');

// base58 alphabet (Bitcoin alphabet)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// default derivation path for HD keys (BIP44 for bolt)
const DEFAULT_DERIVATION_PATH = {
  purpose: BIP44_PURPOSE,
  coinType: BOLT_COIN_TYPE,
  account: 0,      // First account
  change: 0,       // External chain
  index: 0         // First address
};

/**
 * derivation path interface
 */
export interface DerivationPath {
  purpose: number;
  coinType: number;
  account: number;
  change: number;
  index: number;
}

/**
 * key info interface
 */
export interface KeyInfo {
  privateKey: string;
  publicKey: string;
  address: string;
  path?: string;
}

/**
 * hd key interface for hierarchical deterministic key generation
 */
export interface HDKey {
  mnemonic: string;
  seed: Buffer;
  masterKey: hdkey.HDKey;
  derivationPath: DerivationPath;
}

/**
 * base58 encode
 */
function base58Encode(bytes: Uint8Array): string {
  let encoded = '';
  let num = BigInt('0x' + bytesToHex(bytes));

  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / 58n;
  }

  // handle leading zeros
  for (const byte of bytes) {
    if (byte === 0) {
      encoded = '1' + encoded;
    } else {
      break;
    }
  }

  return encoded;
}

/**
 * base58 decode
 */
function base58Decode(encoded: string): Uint8Array {
  let num = 0n;

  for (const char of encoded) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base58 character');
    }
    num = num * 58n + BigInt(index);
  }

  // convert to hex and pad if necessary
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) {
    hex = '0' + hex;
  }

  const bytes = hexToBytes(hex);

  // handle leading ones (zeros)
  let leadingOnes = 0;
  for (const char of encoded) {
    if (char === '1') {
      leadingOnes++;
    } else {
      break;
    }
  }

  if (leadingOnes > 0) {
    const result = new Uint8Array(leadingOnes + bytes.length);
    result.set(bytes, leadingOnes);
    return result;
  }

  return bytes;
}

/**
 * create address from public key
 */
export function publicKeyToAddress(publicKey: Uint8Array | string, prefix: number = 0x00): string {
  // convert to bytes if hex string
  const pubKeyBytes = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey;

  // step 1: sha256 hash of public key
  const sha256Hash = sha256(pubKeyBytes);

  // step 2: ripemd160 hash of sha256 hash
  const pubKeyHash = ripemd160(sha256Hash);

  // step 3: add version byte (prefix)
  const versionedHash = new Uint8Array(21);
  versionedHash[0] = prefix;
  versionedHash.set(pubKeyHash, 1);

  // step 4: double sha256 for checksum
  const checksum = sha256(sha256(versionedHash)).slice(0, 4);

  // step 5: append checksum
  const addressBytes = new Uint8Array(25);
  addressBytes.set(versionedHash);
  addressBytes.set(checksum, 21);

  // step 6: base58 encode
  return base58Encode(addressBytes);
}

/**
 * validate bitcoin-style address
 */
export function validateAddress(address: string): boolean {
  try {
    // check length (25-34 characters for bitcoin addresses)
    if (address.length < 25 || address.length > 34) {
      return false;
    }

    // check valid base58 characters
    const validChars = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    if (!validChars.test(address)) {
      return false;
    }

    // decode and verify checksum
    const decoded = base58Decode(address);
    if (decoded.length !== 25) {
      return false;
    }

    const versionedHash = decoded.slice(0, 21);
    const checksum = decoded.slice(21);
    const calculatedChecksum = sha256(sha256(versionedHash)).slice(0, 4);

    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== calculatedChecksum[i]) {
        return false;
      }
    }

    return true;
  } catch (error) {
    return false;
  }
}

/**
 * generate key info from private key
 */
export function generateFromPrivateKey(privateKey: string | Uint8Array, prefix: number = 0x00): KeyInfo {
  // convert to hex string if bytes
  const privateKeyHex = typeof privateKey === 'string'
    ? privateKey
    : bytesToHex(privateKey);

  // create key pair from private key
  const keyPair = secp256k1.keyFromPrivate(privateKeyHex, 'hex');

  // get public key (uncompressed)
  const publicKey = keyPair.getPublic(false, 'hex');

  // generate address
  const address = publicKeyToAddress(publicKey, prefix);

  return {
    privateKey: privateKeyHex,
    publicKey,
    address
  };
}

/**
 * generate new random address
 */
export function generateAddress(prefix: number = 0x00): KeyInfo {
  // generate secure random private key
  let privateKey: Uint8Array;

  do {
    // use crypto.randomBytes if available (node.js)
    if (crypto.randomBytes) {
      const buffer = crypto.randomBytes(32);
      privateKey = new Uint8Array(buffer);
    } else if (crypto.getRandomValues) {
      // use crypto.getRandomValues for browser/bun
      privateKey = new Uint8Array(32);
      crypto.getRandomValues(privateKey);
    } else {
      throw new Error('No secure random number generator available');
    }
  } while (!isValidPrivateKey(privateKey));

  return generateFromPrivateKey(privateKey, prefix);
}

/**
 * validate private key
 */
function isValidPrivateKey(key: Uint8Array): boolean {
  // check if it's a valid secp256k1 private key
  // must be non-zero and less than the curve order
  const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const keyNum = BigInt('0x' + bytesToHex(key));
  return keyNum > 0n && keyNum < n;
}

/**
 * create HD key from mnemonic
 */
export function createHDKey(
  mnemonic?: string,
  derivationPath: Partial<DerivationPath> = {}
): HDKey {
  // generate or use provided mnemonic
  const seedPhrase = mnemonic || bip39.generateMnemonic();

  // validate mnemonic
  if (!bip39.validateMnemonic(seedPhrase)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // generate seed from mnemonic
  const seed = bip39.mnemonicToSeedSync(seedPhrase);

  // create master key from seed
  const masterKey = hdkey.fromMasterSeed(seed);

  // merge with default derivation path
  const fullPath = { ...DEFAULT_DERIVATION_PATH, ...derivationPath };

  return {
    mnemonic: seedPhrase,
    seed,
    masterKey,
    derivationPath: fullPath
  };
}

/**
 * derive key from HD key
 */
export function deriveKey(
  hdKey: HDKey,
  path?: Partial<DerivationPath>,
  prefix: number = 0x00
): KeyInfo {
  // merge path with HD key's default path
  const derivationPath = { ...hdKey.derivationPath, ...path };

  // build BIP44 derivation path string
  const pathString = `m/${derivationPath.purpose}'/${derivationPath.coinType}'/${derivationPath.account}'/${derivationPath.change}/${derivationPath.index}`;

  // derive key
  const derivedKey = hdKey.masterKey.derive(pathString);

  // get private key
  const privateKey = derivedKey.privateKey;
  if (!privateKey) {
    throw new Error('Failed to derive private key');
  }

  // generate key info
  const keyInfo = generateFromPrivateKey(privateKey, prefix);
  keyInfo.path = pathString;

  return keyInfo;
}

/**
 * derive multiple addresses from HD key
 */
export function deriveAddresses(
  hdKey: HDKey,
  count: number = 10,
  startIndex: number = 0,
  prefix: number = 0x00
): KeyInfo[] {
  const addresses: KeyInfo[] = [];

  for (let i = 0; i < count; i++) {
    const keyInfo = deriveKey(hdKey, { index: startIndex + i }, prefix);
    addresses.push(keyInfo);
  }

  return addresses;
}

/**
 * restore HD key from mnemonic
 */
export function restoreFromMnemonic(
  mnemonic: string,
  derivationPath?: Partial<DerivationPath>
): HDKey {
  return createHDKey(mnemonic, derivationPath);
}

/**
 * get address from public key (convenience function)
 */
export function getAddressFromPublicKey(publicKey: string, prefix: number = 0x00): string {
  return publicKeyToAddress(publicKey, prefix);
}

/**
 * export private key as WIF (Wallet Import Format)
 */
export function exportPrivateKeyWIF(privateKey: string, prefix: number = 0x80): string {
  const keyBytes = hexToBytes(privateKey);

  // add version byte
  const versionedKey = new Uint8Array(33);
  versionedKey[0] = prefix;
  versionedKey.set(keyBytes, 1);

  // calculate checksum
  const checksum = sha256(sha256(versionedKey)).slice(0, 4);

  // append checksum
  const wifBytes = new Uint8Array(37);
  wifBytes.set(versionedKey);
  wifBytes.set(checksum, 33);

  return base58Encode(wifBytes);
}

/**
 * import private key from WIF
 */
export function importPrivateKeyWIF(wif: string): string {
  const decoded = base58Decode(wif);

  if (decoded.length !== 37) {
    throw new Error('Invalid WIF format');
  }

  // verify checksum
  const versionedKey = decoded.slice(0, 33);
  const checksum = decoded.slice(33);
  const calculatedChecksum = sha256(sha256(versionedKey)).slice(0, 4);

  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== calculatedChecksum[i]) {
      throw new Error('Invalid WIF checksum');
    }
  }

  // extract private key (skip version byte)
  return bytesToHex(versionedKey.slice(1));
}

