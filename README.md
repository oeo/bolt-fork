# bolt

`bolt` is a pre-alpha proof-of-work blockchain using an account model. development uses bun and typescript.

## status

bolt is not ready for production use. see [plan.md](plan.md) for completed stability work and remaining launch gates.

## currency

mainnet parameters:

- **symbol**: BOLT
- **base unit**: watt (W)
- **precision**: 1 BOLT = 100,000,000 watts
- **maximum supply**: 21,000,000 BOLT
- **initial reward**: 50 BOLT per block
- **halving interval**: 210,000 blocks

## requirements

- bun
- docker with docker compose
- Kubo, provided by the compose stack or a local daemon

## quick start

the compose stack works without `.env`. mining and mining api default to disabled. api, metrics, Prometheus, and Grafana host ports bind to loopback. tcp p2p and ipfs swarm ports bind to all host interfaces. public api routes remain unauthenticated, and Grafana uses default `admin` credentials unless configured otherwise.

```bash
bun install
docker compose up -d --wait
docker compose logs -f
docker compose down
```

## multi-node deployment test

the bats suite places two bolt nodes and their Kubo daemons on separate Docker networks joined only by a pinned router fixture. it mines through the external getblocktemplate api, verifies routed discovery, block synchronization, pending transaction relay, competing partition branches, higher-work convergence, router interruption and recovery, and state persistence across restart.

```bash
bun run test:bats
```

## services

| service | port |
| --- | ---: |
| rest api | `7333` |
| tcp p2p | `8333` |
| metrics | `7336` |
| ipfs swarm | `4001` |
| Grafana | `3000` |
| Prometheus | `9090` |

## api routes

- `GET /blocks`
- `GET /blocks/:id`
- `GET /blockchain/info`
- `POST /transactions`
- `GET /transactions/:hash`
- `GET /accounts/:address/balance`
- `GET /accounts/:address/nonce`
- `GET /accounts/:address/state`
- `GET /mempool`
- `GET /mempool/transactions`
- `GET /health`
- `POST /mining/template`, disabled by default and bearer-authenticated
- `POST /mining/submit`, disabled by default and bearer-authenticated

## configuration

```bash
DATA_DIR=./data
MINING_ENABLED=false
MINER_ADDRESS=
MINING_API_ENABLED=false
MINING_API_TOKEN=
API_HOST=127.0.0.1
API_PORT=7333
TCP_PORT=8333
METRICS_HOST=127.0.0.1
METRICS_PORT=7336
BOLT_NETWORK=devnet
IPFS_API=http://localhost:5001
IPFS_BOOTSTRAP_ENABLED=true
STATIC_PEERS=
```

`BOLT_NETWORK` accepts `mainnet`, `testnet`, or `devnet`. mainnet startup is disabled until launch difficulty is selected.

`STATIC_PEERS` accepts comma-separated `nodeId@host:port` entries. static peers are identity-bound during the signed handshake and supplement ipfs discovery.

## testing

```bash
bun test --bail
bun test --bail tests/unit
bun test --bail tests/integration
bun test --bail tests/unit/protocol.test.ts
bun run test:bats
```

See [docs/development.md](docs/development.md) for development setup.

## cold recovery

stop the node before storage maintenance. backups include an LMDB snapshot, node identity, and chain manifest.

```bash
bun run storage verify ./data
bun run storage backup ./data ./backup
bun run storage restore ./backup ./restored-data
```

restore requires an empty destination and verifies staged data before replacing it.

## testnet tools

the reference wallet signs locally and verifies testnet chain identity before use:

```bash
bun run wallet create --api https://testnet.example --keystore ~/.bolt/testnet-wallet.json
bun run wallet show --api https://testnet.example --keystore ~/.bolt/testnet-wallet.json
```

the faucet is a separate single-worker service backed by SQLite. it requires a private node API, expected genesis hash, mounted hot-key file, persistent database, and public TLS proxy. testnet chain state can be cleared while preserving node identity only while the node is stopped:

```bash
bun run reset:testnet ./data --confirm-reset-testnet
```

## license

MIT
