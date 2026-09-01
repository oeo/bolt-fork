# bolt addresses

## address format

bolt uses Bitcoin-style base58-encoded addresses with the following structure:
- 20-byte public key hash (RIPEMD160 of SHA256)
- 4-byte checksum
- Version byte prefix (0x00 for mainnet)

Example address: `1KUwSMN3Nijxr18keUBP1wJa11JFiHUt7D`

## hd key derivation

bolt uses hierarchical deterministic (HD) key generation following BIP44 standard with a custom coin type.

### derivation path

```
m / 44' / 1057' / account' / change / index
```

- `44'` - BIP44 purpose (hardened)
- `1057'` - bolt coin type (hardened)
- `account'` - Account index (hardened), starting from 0
- `change` - 0 for external addresses, 1 for internal (change) addresses
- `index` - Address index within the account, starting from 0

### example paths

- First address: `m/44'/1057'/0'/0/0`
- Second address: `m/44'/1057'/0'/0/1`
- First change address: `m/44'/1057'/0'/1/0`
- Second account, first address: `m/44'/1057'/1'/0/0`

### mnemonic generation

bolt supports both 12-word (128-bit) and 24-word (256-bit) BIP39 mnemonic phrases for seed generation.

## address generation

Addresses can be generated using the `generateAddress()` function from `src/crypto/address.ts`:

```typescript
import { generateAddress } from './src/crypto/address';

// generate a new address with private key
const { address, privateKey, publicKey } = generateAddress();
```

For HD key generation with mnemonic phrases, use the HD key functions in the same module.

## technical details

- **Elliptic curve**: secp256k1 (same as Bitcoin/Ethereum)
- **wallet address key format**: uncompressed (65 bytes)
- **transfer public key format**: canonical compressed secp256k1 encoding (33 bytes)
- **Address encoding**: Base58check
- **Checksum**: First 4 bytes of double SHA256

## security considerations

- Never share your mnemonic phrase or private keys
- The 160-bit address space provides sufficient collision resistance
- HD keys allow unlimited address generation from a single seed
- Each account is cryptographically isolated
