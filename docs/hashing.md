# Hashing system

## Dynamic algorithm support

bolt supports multiple proof-of-work algorithms, configurable per chain.

## Supported algorithms

### SHA-256
- Standard Bitcoin algorithm
- 256-bit output
- Fast and well-tested

### SHA-512
- 512-bit output (first 256 bits used for difficulty)
- More collision resistant
- Slightly slower than SHA-256

### Scrypt
- Memory-hard algorithm
- ASIC resistant
- Configurable parameters (N, r, p)

### Double-SHA-256
- Bitcoin's actual algorithm
- SHA-256(SHA-256(data))
- Extra security against length extension attacks

## Configuration

Set in chain config:
```typescript
const config = {
  hashAlgorithm: 'scrypt',
  // scrypt-specific options
  scryptOptions: {
    N: 1024,  // CPU/memory cost
    r: 8,     // block size
    p: 1      // parallelization
  }
}
```

## Difficulty adjustment

The difficulty system works identically across all algorithms:

1. All hashes are compared as 256-bit numbers
2. SHA-512 uses only first 256 bits for difficulty
3. Target = MAX_TARGET / difficulty
4. Block valid if: hash <= target

## Example usage

```typescript
import { hash, hashMeetsDifficulty } from './crypto/hash';

// mine a block
let nonce = 0;
while (true) {
  const blockData = previousHash + merkleRoot + timestamp + nonce;
  const blockHash = hash(blockData, 'sha256');
  
  if (hashMeetsDifficulty(blockHash, difficulty)) {
    // valid block found!
    break;
  }
  nonce++;
}
```

## Chain version hash

The hash algorithm is included in the chain version hash:
```typescript
const chainHash = calculateChainVersionHash({
  hashAlgorithm: 'scrypt',
  network: 'testnet',
  // ... other parameters
});
```

This ensures nodes using different algorithms cannot connect.