// lmdb-demo.ts
// Run with: bun lmdb-demo.ts

import { open } from 'lmdb';

// Demo: Store JSON as efficient binary in LMDB using Bun's native functions

async function main() {
  console.log('🚀 LMDB Binary Storage Demo with Bun\n');

  // 1. Open LMDB database
  const db = open({
    path: './demo-db',
    compression: false, // We'll handle our own encoding
  });

  // 2. Create test data (complex JSON with BigInt)
  const testAccount = {
    address: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1',
    balance: BigInt('1000000000000000000'), // 1 ETH in wei
    nonce: 42,
    transactions: ['tx1', 'tx2', 'tx3'],
    metadata: {
      createdAt: Date.now(),
      lastActive: Date.now(),
      tags: ['whale', 'active']
    }
  };

  console.log('📝 Original Data:');
  console.log(testAccount);
  console.log('\n-------------------\n');

  // 3. Convert to JSON string (handling BigInt)
  const jsonString = JSON.stringify(testAccount, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );

  console.log('📄 JSON String Length:', jsonString.length, 'bytes');

  // 4. Convert to binary using Bun's native function
  const binaryData = Buffer.from(jsonString); // or Bun.stringToBytes(jsonString)

  console.log('📦 Binary Data Length:', binaryData.length, 'bytes');
  console.log('📦 Binary Preview:', binaryData.slice(0, 50), '...\n');

  // 5. Store in LMDB as binary
  await db.put('account:1', binaryData);
  console.log('✅ Stored in LMDB as binary\n');

  // 6. Retrieve from LMDB
  const retrievedBinary = await db.get('account:1');
  console.log('📥 Retrieved Binary Length:', retrievedBinary.length, 'bytes');

  // 7. Convert back to string
  const retrievedJson = retrievedBinary.toString(); // or Bun.bytesToString(retrievedBinary)
  console.log('📄 Decoded JSON String Length:', retrievedJson.length, 'bytes');

  // 8. Parse JSON (handling BigInt)
  const retrievedAccount = JSON.parse(retrievedJson, (key, value) => {
    // Convert balance back to BigInt
    if (key === 'balance') return BigInt(value);
    return value;
  });

  console.log('\n📝 Retrieved Data:');
  console.log(retrievedAccount);

  // 9. Verify they match
  console.log('\n✅ Verification:');
  console.log('Address matches:', testAccount.address === retrievedAccount.address);
  console.log('Balance matches:', testAccount.balance === retrievedAccount.balance);
  console.log('Nonce matches:', testAccount.nonce === retrievedAccount.nonce);

  // 10. Show storage efficiency
  console.log('\n📊 Storage Efficiency:');
  console.log('JSON string size:', jsonString.length, 'bytes');
  console.log('Binary size:', binaryData.length, 'bytes');
  console.log('Savings:', '0% (same size for UTF-8 text)');

  // 11. Better binary encoding example (manual)
  console.log('\n-------------------');
  console.log('🔧 Optimized Binary Encoding:\n');

  // Create efficient binary encoding
  const efficientBinary = Buffer.allocUnsafe(68); // Fixed size
  let offset = 0;

  // Store address as 20 bytes (remove 0x prefix)
  Buffer.from(testAccount.address.slice(2), 'hex').copy(efficientBinary, offset);
  offset += 20;

  // Store balance as 32 bytes
  const balanceHex = testAccount.balance.toString(16).padStart(64, '0');
  Buffer.from(balanceHex, 'hex').copy(efficientBinary, offset);
  offset += 32;

  // Store nonce as 8 bytes
  efficientBinary.writeBigUInt64BE(BigInt(testAccount.nonce), offset);
  offset += 8;

  // Store timestamp as 8 bytes
  efficientBinary.writeBigUInt64BE(BigInt(testAccount.metadata.createdAt), offset);

  console.log('📦 Efficient Binary Length:', efficientBinary.length, 'bytes');
  console.log('📊 Space saved:', jsonString.length - efficientBinary.length, 'bytes');
  console.log('📊 Compression ratio:', ((1 - efficientBinary.length / jsonString.length) * 100).toFixed(1) + '%');

  // Store efficient version
  await db.put('account:2', efficientBinary);

  // Decode efficient version
  const retrieved2 = await db.get('account:2');
  const decodedAddress = '0x' + retrieved2.slice(0, 20).toString('hex');
  const decodedBalance = BigInt('0x' + retrieved2.slice(20, 52).toString('hex'));
  const decodedNonce = Number(retrieved2.readBigUInt64BE(52));
  const decodedTimestamp = Number(retrieved2.readBigUInt64BE(60));

  console.log('\n📝 Decoded Efficient Binary:');
  console.log({
    address: decodedAddress,
    balance: decodedBalance,
    nonce: decodedNonce,
    timestamp: decodedTimestamp
  });

  // Clean up
  await db.close();

  // Remove demo database
  const fs = require('fs');
  fs.rmSync('./demo-db', { recursive: true, force: true });

  console.log('\n✨ Demo complete! Database cleaned up.');
}

// Run the demo
main().catch(console.error);
