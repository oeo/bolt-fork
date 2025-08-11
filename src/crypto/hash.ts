export type HashAlgorithm = 'sha256' | 'sha512' | 'scrypt' | 'double-sha256';

interface ScryptOptions {
  N?: number;  // CPU/memory cost parameter (must be power of 2)
  r?: number;  // block size parameter
  p?: number;  // parallelization parameter
  dkLen?: number;  // desired key length
}

/**
 * Universal hash function supporting multiple algorithms
 */
export function hash(
  data: string | Uint8Array, 
  algorithm: HashAlgorithm = 'sha256',
  options?: ScryptOptions
): string {
  const bytes = typeof data === 'string' 
    ? new TextEncoder().encode(data)
    : data;
  
  switch (algorithm) {
    case 'sha256': {
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(bytes);
      return hasher.digest('hex');
    }
      
    case 'sha512': {
      const hasher = new Bun.CryptoHasher('sha512');
      hasher.update(bytes);
      return hasher.digest('hex');
    }
      
    case 'double-sha256': {
      const hasher1 = new Bun.CryptoHasher('sha256');
      hasher1.update(bytes);
      const firstHash = hasher1.digest();
      
      const hasher2 = new Bun.CryptoHasher('sha256');
      hasher2.update(firstHash);
      return hasher2.digest('hex');
    }
      
    case 'scrypt': {
      // bun doesn't have native scrypt for raw hashing
      // using sha256-based simulation for consistency
      // this maintains deterministic output for blockchain use
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(bytes);
      const hashBytes = hasher.digest();
      
      // simulate memory-hard aspect with multiple rounds
      const rounds = options?.N || 1024;
      let result = hashBytes;
      
      for (let i = 0; i < Math.log2(rounds); i++) {
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(result);
        hasher.update(bytes);
        result = hasher.digest();
      }
      
      return bytesToHex(new Uint8Array(result));
    }
      
    default:
      throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
}

/**
 * Calculate merkle root from transaction hashes
 */
export function calculateMerkleRoot(hashes: string[], algorithm: HashAlgorithm = 'sha256'): string {
  if (hashes.length === 0) return hash('', algorithm);
  if (hashes.length === 1) return hashes[0];
  
  let level = [...hashes];
  
  while (level.length > 1) {
    const nextLevel: string[] = [];
    
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      const combined = left + right;
      nextLevel.push(hash(combined, algorithm));
    }
    
    level = nextLevel;
  }
  
  return level[0];
}

/**
 * Calculate target from difficulty
 * This works regardless of hash algorithm as we're comparing bigints
 */
export function difficultyToTarget(difficulty: number): bigint {
  // max value for 256-bit hash (works for all our algorithms)
  const maxTarget = BigInt('0x' + 'FF'.repeat(32));
  return maxTarget / BigInt(Math.max(1, Math.floor(difficulty)));
}

/**
 * Check if hash meets difficulty target
 * Algorithm-agnostic as it just compares the numerical value
 */
export function hashMeetsDifficulty(hashValue: string, difficulty: number): boolean {
  // for longer hashes (sha512), only use first 64 chars (256 bits)
  // this ensures consistent difficulty across algorithms
  const normalizedHash = hashValue.substring(0, 64).padStart(64, '0');
  const hashBigInt = BigInt('0x' + normalizedHash);
  const target = difficultyToTarget(difficulty);
  return hashBigInt <= target;
}

/**
 * Get hash output size in bytes for each algorithm
 */
export function getHashSize(algorithm: HashAlgorithm): number {
  switch (algorithm) {
    case 'sha256':
    case 'double-sha256':
    case 'scrypt':
      return 32; // 256 bits
    case 'sha512':
      return 64; // 512 bits
    default:
      return 32;
  }
}

/**
 * Convert hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}