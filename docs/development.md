# development

bolt is pre-alpha and release-blocked. Review [plan.md](../plan.md) before development or deployment work.

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

Create `.env` with settings needed for the local node:

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

## single node

The compose stack starts bolt, Kubo, and monitoring services.

run it only on a trusted isolated host. compose publishes unauthenticated bolt api, Kubo rpc, metrics, and monitoring services to host interfaces. Grafana uses default `admin` credentials.

```bash
docker compose up -d
docker compose logs -f bolt
docker compose down
```

To run bolt directly, start Kubo first and set `IPFS_API` to its api address:

```bash
bun run src/index.ts
```

## multi-node cluster

the cluster scripts are not safe to use. generated node compose files do not set `IPFS_API` to the Kubo sidecar, so bolt containers cannot complete startup. the stop script removes cluster volumes, and `--clean` can delete unrelated volumes matching its broad name pattern. fix sidecar wiring and volume scoping before running these scripts.

## monitoring

Root compose services use these addresses:

- Grafana: `http://localhost:3000`
- Prometheus: `http://localhost:9090`
- Loki: `http://localhost:3100`
- bolt metrics: `http://localhost:7336/metrics`
- bolt health: `http://localhost:7333/health`

```bash
curl http://localhost:7336/metrics
curl http://localhost:7333/health
```

## testing

```bash
bun test --bail
bun test --bail tests/unit
bun test --bail tests/integration
bun test --bail tests/unit/protocol.test.ts
bun test --bail --coverage
bats tests/bats
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

## resources

- [bun documentation](https://bun.sh/docs)
- [docker compose documentation](https://docs.docker.com/compose/)
- [Kubo documentation](https://docs.ipfs.tech/install/command-line/)
