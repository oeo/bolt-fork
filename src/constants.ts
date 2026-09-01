/**
 * immutable protocol constants for bolt blockchain
 * these values are fundamental to the protocol and never change
 */

export const NETWORK_MAGIC = 0x12699C94; // network protocol magic bytes

// ===========================
// currency definition
// ===========================
export const WATTS_PER_BOLT = 100_000_000n;
export const GENESIS_SLOGAN = 'we will craft citadels in the clouds or bury vaults within the ashes.';
export const CURRENCY_DECIMALS = 8;

// ===========================
// bip standards
// ===========================
export const BIP44_PURPOSE = 44;        // BIP44 HD wallet standard
export const BOLT_COIN_TYPE = 1057;     // bolt's registered coin type

// ===========================
// genesis block
// ===========================
export const GENESIS_PREVIOUS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
export const GENESIS_BLOCK_INDEX = 0;

// ===========================
// cryptographic sizes (bytes)
// ===========================
export const HASH_SIZE_SHA256 = 32;
export const HASH_SIZE_SHA512 = 64;
export const PRIVATE_KEY_SIZE = 32;
export const PUBLIC_KEY_COMPRESSED_SIZE = 33;
export const PUBLIC_KEY_UNCOMPRESSED_SIZE = 65;
export const ADDRESS_CHECKSUM_SIZE = 4;
