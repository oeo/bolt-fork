---
schema: bolt.audit.v1
audited_at: 2026-08-31
model_id: openrouter/~deepseek/deepseek-v4-flash-latest
model_slug: deepseek-v4-flash-latest
repository: bolt-ts
commit: 93a5bd095dce83f5f2287e974f6c578296093f2d
branch: master
scope: all
meditation_min: 8 (core), 5 (deployment)
coverage: crypto, consensus, transaction auth, storage/persistence, networking, deployment, tests (delegated in 4 scopes; core keystone read directly)
worktree: clean
---

# Audit: bolt-ts

## Verdict

Overall maturity: prototype/pre-alpha

Release decision: blocked for public testnet

Requested-feature decision: blocked — runs securely only on a trusted/private testnet; public testnet attackable via unbounded reorg depth combined with trivial PoW and public discovery.

## High Findings

```text
h1  sync-manager.ts:409; blockchain.ts:666,757; testnet.ts:21  high: unbounded reorg depth; only cumulative-work gate. >50%-hashrate attacker forking deep rewrites up to 2000 blocks + full state repeatedly (trivial PoW at difficulty 100000->1 floor). DoS, not fund theft. fix: cap fork depth vs tip (reject ancestor < tip-N); raise testnet difficulty floor or checkpoint.
h2  docker-compose.yml:42; Dockerfile:19; src/utils/file-logger.ts:56  high: ./logs bind mount root-owned on Linux + non-root USER bun -> EACCES on open -> unhandled stream 'error' -> process exit -> restart loop. fix: pre-create ./logs node-writable; or named volume + chown; or drop bind.
h3  src/utils/file-logger.ts:148-151  high: error.log never rotates; unbounded growth on error storms fills disk. fix: rotate errorStream with same maxFileSize/maxFiles as bolt.log.
```

## Medium Findings

```text
m1  src/core/mempool.ts:192-199,233  medium: mempool restore throws on any invalid persisted entry -> initialize throws -> node crash-loop on restart; persisted state trusted. fix: drop offending entry + removal, do not throw.
m2  src/api/server.ts:110-113; docker-compose.yml:43-47  medium: POST /transactions has no auth or rate limit (128KB cap only); safe only behind 127.0.0.1. fix: per-IP rate limit on submission when API exposed.
m3  .gitignore (no /data, no .identity); src/utils/identity.ts:12  medium: default dataDir ./data holds .identity private key, not ignored; accidental git add stages key. fix: add /data/ and /.identity.
m4  src/index.ts:557; .env:17  medium: env drift. .env sets dead ENABLE_MINING=true + empty MINER_ADDRESS + dead P2P_PORT/WS_PORT; runtime mines off MINING_ENABLED. mining silently off despite .env. fix: delete dead vars, keep one canonical name.
m5  src/storage/lmdb-manager.ts:44  medium: LMDB opens without mode 0o700; data.mdb 0644 world-readable. fix: open({mode:0o700}) and chmod data dir.
m6  src/api/server.ts:113; src/index.ts:360-368  medium: /health is liveness-only; wedged LMDB/consensus reports ok -> no restart. fix: healthcheck verifies storage + chain tip advance.
m7  compose/grafana.yml:14  medium: GF_ADMIN_PASSWORD defaults to "admin". fix: require explicit strong password.
m8  scripts/metrics-server.ts:15-16  medium: standalone metrics script binds 0.0.0.0, no auth. fix: default hostname 127.0.0.1.
```

## Low Findings

```text
l1  src/core/difficulty.ts:167  low: expectedTime uses interval-1 blocks vs actual interval-1;p systematic difficulty calibration offset; deterministic, no fork divergence. fix: expectedTime cover interval-1 blocks per actual span.
l2  src/crypto/address.ts:375  low: importPrivateKeyWIF checks length+checksum only, not scalar range; crafted-but-checksummed out-of-range key returned. wallet-side only, not consensus-enforced. fix: add secp256k1.isValidPrivateKey after decode.
l3  src/core/block-executor.ts:50  low: minFeePerByte is mempool-only, not block-validity rule; zero/low-fee tx passes block validity if sender funds cover it. accepted by design, documented. flag for checklist.
l4  src/crypto/hash.ts:36-69  low: scrypt branch is a fake sha256 simulation, declared as available algorithm; mining forced to sha256 (blockchain ctor throws otherwise). dead path, debt.
l5  docker-compose.bats.yml:47  low: hardcoded MINING_API_TOKEN in-repo. devnet-only CI, acceptable; keep devnet-bounded.
l6  src/network/peer-discovery.ts:81,107; network-orchestrator.ts:148  low: public bootstrap.libp2p.io bootstrap, /bolt/<chainId>/<genesisHash>/peers/<ver> topic exposes every node tcp:port. AGENTS mandates public bootstrap; mitigable with depth cap (h1).
```

## Maturity

| Area | Maturity | Evidence |
|---|---|---|
| core primitives | beta | executeBlock deterministic, sorted stateRoot verified at addBlock/reorg/integrity; bigint serialization lossless; canonical field serialization |
| transaction authorization | beta | every transfer sig verified vs its own compressed pubkey over canonical domain-tagged hash, ECDSA lowS probe-verified; chainId + strict per-account nonce block replay |
| consensus | alpha | cumulative-work fork choice sound but no reorg-depth cap (h1); difficulty calibration offset (l1); coinbase reward = reward+fees no-negative, verified |
| state and persistence | beta | single atomic LMDB txn per canonical mutation + reorg, SIGKILL-proven; backups staged/verified/chain-gated; mempool persisted + revalidated |
| networking | alpha | strong signed handshake, HMAC+seq, magic=NETWORK_MAGIC^chainId, frame/peer/rate caps; blocked by h1 reorg DoS for public exposure |
| deployment | prototype | pinned+sha base, USER bun, frozen lockfile; broken by h2 logs bind-mount, h3 logging; liveness-only healthcheck m6 |
| testing | beta | 29 files, no skipped/empty/disabled, CI gates typecheck+bun audit+test:dormant+bats; real 2-node reorg/SIGKILL/partition bats. gaps: reorg-depth, malicious peer, double-mine race, tx flood, healthcheck failure |
| release process | alpha | CI gates present and executing; missing executable reorg-depth + deployment-smoke gates |
| requested feature (secure public testnet) | blocked | h1 reorg DoS + h2/h3 deployment + m2 tx flood remain |

## Verification

| Command | Exit | Result |
|---|---:|---|
| git rev-parse HEAD | 0 | 93a5bd095dce83f5f2287e974f6c578296093f2d |
| monk_tree | 0 | 125 files, ~247k tokens mapped; core min 8 / deployment min 5 |
| probe: noble v2.3.0 lowS verify + malleated-sig acceptance | pass | forged high-S sig -> verify=false (dual defense) |
| source reads (read-only) | pass | blockchain.ts reorganize/validateHeaderChain; mempool restore; index.ts startup; file-logger; lmdb-manager |

Tests not re-run (read-only audit; existing suite asserted green by CI). Findings derived from current source and targeted read, not replayed test runs.

## Required Gates

1. Cap fork depth vs tip (reject ancestor < tip-N) and add a reorg-depth unit + multi-node bats test. Fixes h1.
2. Resolve ./logs bind-mount ownership (h2) and error.log rotation (h3); add deployment smoke check on Linux non-root.

## Coverage

Mapped 125 files. Ingested: 4 delegated scopes (consensus/crypto/auth via ~18 src files + 7 unit test files + docs; networking via 8 src files + 3 test files; storage via 8 src files + 3 test files; deployment/runtime/tests via Dockerfile/compose/CI/index/api/metrics/logger + full tests/ inventory). Core keystone (signature, address, hash, transaction, block-executor, blockchain reorg path) read directly and verified. Prior audits present in audits/ (08-25, 08-26, 08-27) disregarded per audit-skill greenfield independence rule.

## Limitations

Tests not executed (read-only audit prohibits mutation; CI gates assumed green from workflow). Network/multi-node and Docker runtime behavior assessed from source + compose, not a live deploy. bootstrap libp2p and IPFS behavior assessed at source. None otherwise.
