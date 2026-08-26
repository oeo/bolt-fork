# bolt

`bolt` is a pre-alpha proof-of-work blockchain using an account model. development uses bun and typescript.

## status

bolt is not ready for production use. see [plan.md](plan.md) for completed release-gate remediation and future scope.

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

the compose stack works without `.env`. mining defaults to disabled. api, metrics, Prometheus, and Grafana host ports bind to loopback. tcp p2p and ipfs swarm ports bind to all host interfaces. the api remains unauthenticated, and Grafana uses default `admin` credentials unless configured otherwise.

```bash
bun install
docker compose up -d
docker compose logs -f
docker compose down
```

## multi-node deployment test

the bats suite builds two bolt nodes with separate Kubo daemons. it verifies block synchronization, pending transaction relay, and state persistence across restart.

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
- `GET /mempool`
- `GET /mempool/transactions`
- `GET /health`

## configuration

```bash
DATA_DIR=./data
MINING_ENABLED=false
API_HOST=127.0.0.1
API_PORT=7333
TCP_PORT=8333
METRICS_HOST=127.0.0.1
METRICS_PORT=7336
BOLT_NETWORK=devnet
IPFS_API=http://localhost:5001
IPFS_BOOTSTRAP_ENABLED=true
```

`BOLT_NETWORK` accepts `mainnet`, `testnet`, or `devnet`.

## testing

```bash
bun test --bail
bun test --bail tests/unit
bun test --bail tests/integration
bun test --bail tests/unit/protocol.test.ts
bun run test:bats
```

See [docs/development.md](docs/development.md) for development setup.

## license

MIT
