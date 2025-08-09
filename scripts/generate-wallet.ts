#!/usr/bin/env bun

import * as bip39 from 'bip39';
import { 
  createHDKey, 
  deriveAddresses, 
  deriveKey 
} from '../src/crypto/address';

// parse command line arguments
const args = process.argv.slice(2);
const wordCount = args[0] === '24' ? 256 : 128; // 24 words = 256 bits, 12 words = 128 bits
const addressCount = parseInt(args[1]) || 5;

// generate mnemonic
const mnemonic = bip39.generateMnemonic(wordCount);

// create HD key
const hdKey = createHDKey(mnemonic);

// derive addresses
const addresses = deriveAddresses(hdKey, addressCount);

// output results
console.log('bolt wallet generator');
console.log('=====================\n');

console.log(`mnemonic (${wordCount === 256 ? '24' : '12'} words):`);
console.log(mnemonic);
console.log();

console.log('seed (hex):');
console.log(hdKey.seed.toString('hex'));
console.log();

console.log(`derived addresses (first ${addressCount}):`);
console.log('-'.repeat(50));

addresses.forEach((keyInfo, index) => {
  console.log(`\naddress #${index}`);
  console.log(`path:       ${keyInfo.path}`);
  console.log(`address:    ${keyInfo.address}`);
  console.log(`public key: ${keyInfo.publicKey}`);
  console.log(`private key: ${keyInfo.privateKey}`);
});

console.log('\n' + '='.repeat(50));
console.log('important: save your mnemonic phrase securely!');
console.log('never share your private keys with anyone!');