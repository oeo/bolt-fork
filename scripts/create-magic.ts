#!/usr/bin/env bun

// create magic bytes for bolt network protocol
// usage: bun scripts/create-magic.ts [string]

const input = process.argv[2] || "BOLT";

// use bun's native crypto for hashing
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(input);
const hash = hasher.digest();

// take first 4 bytes as magic
const magic = new DataView(hash.buffer).getUint32(0, false);

// output in various formats
console.log(`input: "${input}"`);
console.log(`magic (hex): 0x${magic.toString(16).toUpperCase().padStart(8, '0')}`);
console.log(`magic (decimal): ${magic}`);
console.log(`magic (binary): 0b${magic.toString(2).padStart(32, '0')}`);

// typescript constant format
console.log(`\n// add to src/constants.ts:`);
console.log(`export const NETWORK_MAGIC = 0x${magic.toString(16).toUpperCase()};`);

// verify it's not a common value
const commonValues = [0x00000000, 0xFFFFFFFF, 0xDEADBEEF, 0x12345678];
if (commonValues.includes(magic)) {
  console.warn("\nwarning: magic value is too common, consider using a different input string");
}
