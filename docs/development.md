# development

bolt is pre-alpha. review [plan.md](../plan.md) before development or deployment work.

## prerequisites

- bun
- docker with docker compose
- Kubo, provided by the compose stack or a local daemon

## setup

```bash
git clone https://github.com/oeo/bolt-fork.git bolt-ts
cd bolt-ts
bun install
```

the compose stack does not require `.env`. create one only to override defaults. direct node startup accepts these settings:

```bash
DATA_DIR=./data
MINING_ENABLED=false
MINER_ADDRESS=
MINING_API_ENABLED=false
MINING_API_TOKEN=
API_HOST=127.0.0.1
API_PORT=7333
TCP_PORT=8333
STATIC_PEERS=
P2P_ADVERTISE=false
METRICS_HOST=127.0.0.1
METRICS_PORT=7336
BOLT_NETWORK=devnet
IPFS_API=http://localhost:5001
IPFS_BOOTSTRAP_ENABLED=true
```

`BOLT_NETWORK` accepts `mainnet`, `testnet`, or `devnet`. mainnet startup is disabled until launch difficulty is selected.

fallback mining requires `MINER_ADDRESS` with active network prefix. mining API requires both `MINING_API_ENABLED=true` and non-empty `MINING_API_TOKEN`.

`STATIC_PEERS` accepts comma-separated identity-bound `nodeId@host:port` entries. Kubo remains the normal discovery dependency; static peers provide deterministic seed dialing.

## ordinary edge node

The compose stack starts bolt, Kubo, and monitoring services without publishing p2p ports or endpoint announcements. authenticated outbound connections remain bidirectional.

compose publishes api, metrics, Prometheus, and Grafana to host loopback. public api routes remain unauthenticated, and Grafana uses default `admin` credentials unless configured otherwise. Kubo rpc remains inside the docker network.

```bash
docker compose up -d --wait
docker compose logs -f bolt
docker compose down
```

To run bolt directly, start Kubo first and set `IPFS_API` to its api address:

```bash
bun run src/index.ts
```

`BOLT_NETWORK` is required for direct startup. missing or unknown values fail before storage or networking opens.

## public seed node

seed nodes publish bolt TCP `8333` and Kubo swarm `4001` TCP/UDP. `NODE_HOST` is required by the override.

```bash
NODE_HOST=seed-a.example.org \
STATIC_PEERS='<seed-b-id>@seed-b.example.org:8333' \
docker compose -f docker-compose.yml -f compose/seed.yml up -d --wait
```

`P2P_ADVERTISE=false` suppresses signed endpoint announcements; it does not disable the process-internal listener. host exposure is controlled by Compose and firewall configuration.

## two-host testnet canary

use the same root Compose stack on each host. initialize both nodes once, record their bolt node IDs and Kubo peer IDs, then configure reciprocal peers.

host A:

```bash
BOLT_NETWORK=testnet
NODE_HOST=seed-a.example.org
STATIC_PEERS=<bolt-b-node-id>@seed-b.example.org:8333
P2P_ADVERTISE=true
```

host B:

```bash
BOLT_NETWORK=testnet
NODE_HOST=seed-b.example.org
STATIC_PEERS=<bolt-a-node-id>@seed-a.example.org:8333
P2P_ADVERTISE=true
```

publish TCP `8333` and Kubo swarm `4001` TCP/UDP. keep API, metrics, faucet backend, and Kubo RPC private. configure each Kubo node's `Peering.Peers` with the other seed's Kubo peer ID and swarm address. public libp2p bootstrap remains fallback connectivity.

both hosts must run the same commit and image digest. compare consensus status:

```bash
curl -s http://127.0.0.1:7333/blockchain/info
```

height, latest block hash, latest state root, cumulative difficulty, genesis hash, and protocol version must agree after convergence.

## multi-node deployment test

`docker-compose.bats.yml` starts one advertising seed and one non-advertising edge with separate Kubo daemons on isolated Docker networks. a pinned router fixture is the only member of both networks. the test verifies inbound/outbound peer direction, explicit mempool catch-up, authenticated getblocktemplate mining, competing partition branches, and higher-work convergence.

```bash
bun run test:bats
```

## monitoring

Root compose services use these addresses:

- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- bolt metrics: `http://localhost:7336/metrics`
- bolt health: `http://localhost:7333/health`

```bash
curl http://localhost:7336/metrics
curl http://localhost:7333/health
```

## cold storage

stop bolt before backup, verification, or restore. compose mounts `bolt-backups` at `/backups`.

```bash
bun run storage verify ./data
bun run storage backup ./data ./backup
bun run storage restore ./backup ./restored-data
```

restore rejects non-empty destinations and backups from another configured chain. failed staged verification leaves destination unchanged.

## testing

```bash
bun test --bail
bun test --bail tests/unit
bun test --bail tests/integration
bun test --bail tests/unit/protocol.test.ts
bun test --bail --coverage
bun run test:bats
```

Unit tests cover isolated behavior. Integration tests cover component boundaries. Bats tests exercise deployed nodes through docker.

## development workflow

1. Make one scoped change.
2. Add or update behavior tests.
3. Run relevant tests with `--bail`.
4. Update affected documentation.
5. Submit changes for review.

## wallet generation

```bash
bun run scripts/generate-wallet.ts
```

## reference testnet wallet

the testnet wallet verifies chain ID, genesis hash, and address prefix; stores the mnemonic under PBKDF2-SHA256 and AES-256-GCM; and signs transactions locally.

```bash
bun run wallet create --api http://127.0.0.1:7333 --keystore ~/.bolt/testnet-wallet.json
bun run wallet show --api http://127.0.0.1:7333 --keystore ~/.bolt/testnet-wallet.json
bun run wallet send --api http://127.0.0.1:7333 --keystore ~/.bolt/testnet-wallet.json --to ADDRESS --amount 1.0
bun run wallet status --api http://127.0.0.1:7333 --hash HASH
```

remote APIs must use HTTPS. the wallet is a testnet reference, not a production custody product.

## testnet faucet

the faucet runs as one process with one SQLite writer and durable prepared transactions. configure `BOLT_API`, `TESTNET_GENESIS_HASH`, `FAUCET_KEY_FILE`, and `FAUCET_IP_SECRET`; keep the node API private and terminate public TLS at a reverse proxy.

```bash
bun run faucet
```

the hot key file must be owner-only. refill uses an offline transfer to the faucet address; no remote refill endpoint exists.

## testnet reset

stop the node before reset. this command deletes LMDB chain state and preserves `.identity`. Kubo identity lives in its separate volume and is not changed.

```bash
bun run reset:testnet ./data --confirm-reset-testnet
```

reset rehearsal:

1. stop bolt on both hosts.
2. preserve each `.identity` and Kubo repository.
3. clear chain state with `reset:testnet`.
4. deploy a release with new chain ID, genesis timestamp, difficulty, nonce, and hash.
5. update wallet and faucet expected identity.
6. confirm old storage and old signed transactions are rejected.
7. publish reset generation and history. balances and transactions do not migrate.

## testnet launch gate

create the release-candidate tag before canary. mine through height 61 so the first 60-block testnet epoch retargets. independently calculate the expected difficulty from blocks 1 through 60. test static peers, Kubo discovery, transaction relay, competing branches, restart, Kubo interruption, storage verification, and backup/restore. observe for 24 hours before freezing the candidate identity.

## resources

- [bun documentation](https://bun.sh/docs)
- [docker compose documentation](https://docs.docker.com/compose/)
- [Kubo documentation](https://docs.ipfs.tech/install/command-line/)
