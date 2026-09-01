import { readFile, stat } from 'node:fs/promises';
import { getPublicKey } from '@noble/secp256k1';
import { BoltApiClient } from '../../src/api/client';
import { publicKeyToAddress, validateAddress } from '../../src/crypto/address';
import { createSignedTransaction, TransactionClass } from '../../src/core/transaction';
import { deserialize, serialize } from '../../src/utils/bigint';
import { FaucetDatabase } from './database';

const WATT = 1n;
const BOLT = 100_000_000n;
const config = {
  host: process.env.FAUCET_HOST || '127.0.0.1',
  port: Number(process.env.FAUCET_PORT || 7340),
  nodeUrl: required('BOLT_API'),
  keyFile: required('FAUCET_KEY_FILE'),
  database: process.env.FAUCET_DATABASE || './data/faucet.sqlite',
  expectedGenesis: required('TESTNET_GENESIS_HASH'),
  ipSecret: required('FAUCET_IP_SECRET'),
  payout: BigInt(process.env.FAUCET_PAYOUT_WATTS || BOLT),
  feeReserve: BigInt(process.env.FAUCET_FEE_RESERVE_WATTS || 10_000n * WATT),
  cooldownMs: Number(process.env.FAUCET_COOLDOWN_MS || 86_400_000),
  globalBudget: BigInt(process.env.FAUCET_GLOBAL_BUDGET_WATTS || 100n * BOLT),
  queueCapacity: Number(process.env.FAUCET_QUEUE_CAPACITY || 100),
  trustProxy: process.env.FAUCET_TRUST_PROXY === 'true',
};

const keyStat = await stat(config.keyFile);
if ((keyStat.mode & 0o077) !== 0) throw new Error('Faucet key file must not be group/world accessible');
const privateKey = (await readFile(config.keyFile, 'utf8')).trim();
if (!/^[0-9a-f]{64}$/.test(privateKey)) throw new Error('Invalid faucet private key');
const address = publicKeyToAddress(getPublicKey(privateKey, false), 0x6f);
const api = new BoltApiClient(config.nodeUrl);
const info = await api.chainInfo();
if (info.network !== 'testnet' || info.chainId !== 1058 || info.genesisHash !== config.expectedGenesis || info.addressPrefix !== 0x6f) {
  throw new Error('Faucet node is not expected bolt testnet');
}
const store = new FaucetDatabase(config.database);
let processing = false;
let paused = false;

const timer = setInterval(() => void work(), 1000);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 1024,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: paused ? 'paused' : 'ok', address });
    }
    if (request.method === 'GET' && /^\/requests\/[0-9a-f-]{36}$/.test(url.pathname)) {
      const claim = store.get(url.pathname.slice('/requests/'.length));
      return claim ? json(publicClaim(claim)) : json({ error: 'Not found' }, 404);
    }
    if (request.method !== 'POST' || url.pathname !== '/claim') return json({ error: 'Not found' }, 404);
    if (paused) return json({ error: 'Faucet paused' }, 503);
    const direct = server.requestIP(request)?.address || 'unknown';
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const clientIp = config.trustProxy && ['127.0.0.1', '::1'].includes(direct) && forwarded ? forwarded : direct;
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!body || Object.keys(body).some(key => key !== 'address') || !validateAddress(body.address, 0x6f)) {
      return json({ error: 'Invalid testnet address' }, 400);
    }
    try {
      const claim = store.createClaim({
        address: body.address,
        ipHash: ipHash(clientIp),
        amount: config.payout,
        now: Date.now(),
        cooldownMs: config.cooldownMs,
        windowMs: 86_400_000,
        globalBudget: config.globalBudget,
        capacity: config.queueCapacity,
      });
      return json(publicClaim(claim), 202);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 429);
    }
  }
});

console.log(`bolt testnet faucet ${address} listening on ${server.url}`);

async function work(): Promise<void> {
  if (processing || paused) return;
  const claim = store.nextWork();
  if (!claim) return;
  processing = true;
  try {
    if (claim.status === 'queued') {
      const state = await api.accountState(address);
      let fee = config.feeReserve;
      let transaction;
      for (let attempt = 0; attempt < 5; attempt++) {
        transaction = await createSignedTransaction(
          info.chainId, address, claim.address, claim.amount, state.nextNonce, fee, privateKey
        );
        const requiredFee = BigInt(transaction.getSize()) * info.minFeePerByte;
        if (requiredFee <= fee) break;
        fee = requiredFee;
      }
      if (!transaction || transaction.fee < BigInt(transaction.getSize()) * info.minFeePerByte ||
          state.availableBalance < claim.amount + transaction.fee) {
        paused = true;
        store.setStatus(claim.id, 'blocked');
        return;
      }
      store.prepare(claim.id, state.nextNonce, transaction.hash, serialize(transaction.toObject()));
      claim.status = 'prepared';
      claim.transactionHash = transaction.hash;
      claim.payload = serialize(transaction.toObject());
    }
    if (claim.status === 'prepared') {
      const transaction = TransactionClass.fromObject(deserialize(claim.payload!));
      try {
        await api.submit(transaction.toObject());
        store.setStatus(claim.id, 'submitted');
      } catch {
        try {
          await api.transaction(transaction.hash);
          store.setStatus(claim.id, 'submitted');
        } catch {
          paused = true;
          store.setStatus(claim.id, 'blocked');
        }
      }
    } else if (claim.status === 'submitted') {
      try {
        const transaction = await api.transaction(claim.transactionHash!);
        if (transaction.status === 'confirmed') store.setStatus(claim.id, 'confirmed');
      } catch {}
    }
  } finally {
    processing = false;
  }
}

function ipHash(value: string): string {
  return new Bun.CryptoHasher('sha256', config.ipSecret).update(value).digest('hex');
}

function publicClaim(claim: any) {
  return { id: claim.id, address: claim.address, amount: claim.amount, status: claim.status, transactionHash: claim.transactionHash };
}

function json(value: unknown, status = 200): Response {
  return new Response(serialize(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.stop(true);
    store.close();
    process.exit(0);
  });
}
