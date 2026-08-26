# bolt

`bolt` is a pre-alpha proof-of-work blockchain using an account model. Development uses bun and typescript.

## status

bolt is release-blocked and not ready for production use. See [plan.md](plan.md) for known blockers and planned work.

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

create `.env` with the configuration below. do not copy `.env.example`; it still uses obsolete mining and p2p variable names.

run the compose stack only on a trusted isolated host. it publishes unauthenticated bolt api, Kubo rpc, metrics, and monitoring services to host interfaces. Grafana uses default `admin` credentials.

```bash
bun install
docker compose up -d
docker compose logs -f
docker compose down
```

## multi-node cluster

the cluster scripts are not safe to use. generated node compose files do not connect bolt containers to their Kubo sidecars through `IPFS_API`. the stop script removes cluster volumes, and `--clean` can delete unrelated volumes matching its broad name pattern. deployment remediation must fix both behaviors before this workflow is documented.

## services

| service | port |
| --- | ---: |
| rest api | `7333` |
| tcp p2p | `8333` |
| metrics | `7336` |
| Kubo api | `5001` |
| Grafana | `3000` |
| Prometheus | `9090` |
| Loki | `3100` |

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
- `GET /network/status`
- `GET /peers`
- `POST /peers/connect`
- `GET /health`

## configuration

```bash
DATA_DIR=./data
MINING_ENABLED=false
API_PORT=7333
TCP_PORT=8333
METRICS_PORT=7336
BOLT_NETWORK=devnet
IPFS_API=http://localhost:5001
```

`BOLT_NETWORK` accepts `mainnet`, `testnet`, or `devnet`.

## testing

```bash
bun test --bail
bun test --bail tests/unit
bun test --bail tests/integration
bun test --bail tests/unit/protocol.test.ts
bats tests/bats
```

See [docs/development.md](docs/development.md) for development setup.

## license

MIT
