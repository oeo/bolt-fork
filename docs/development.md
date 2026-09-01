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
METRICS_HOST=127.0.0.1
METRICS_PORT=7336
BOLT_NETWORK=devnet
IPFS_API=http://localhost:5001
IPFS_BOOTSTRAP_ENABLED=true
```

`BOLT_NETWORK` accepts `mainnet`, `testnet`, or `devnet`. mainnet startup is disabled until launch difficulty is selected.

fallback mining requires `MINER_ADDRESS` with active network prefix. mining API requires both `MINING_API_ENABLED=true` and non-empty `MINING_API_TOKEN`.

`STATIC_PEERS` accepts comma-separated identity-bound `nodeId@host:port` entries. Kubo remains the normal discovery dependency; static peers provide deterministic seed dialing.

## single node

The compose stack starts bolt, Kubo, and monitoring services.

compose publishes api, metrics, Prometheus, and Grafana to host loopback. tcp p2p and ipfs swarm ports publish on all host interfaces for peer connectivity. public api routes remain unauthenticated, and Grafana uses default `admin` credentials unless configured otherwise. Kubo rpc remains inside the docker network. set `NODE_HOST` to a routable address before connecting nodes across hosts.

```bash
docker compose up -d --wait
docker compose logs -f bolt
docker compose down
```

To run bolt directly, start Kubo first and set `IPFS_API` to its api address:

```bash
bun run src/index.ts
```

## multi-node deployment test

`docker-compose.bats.yml` starts two bolt nodes with separate Kubo daemons on isolated Docker networks. a pinned router fixture is the only member of both networks. the test installs explicit routes, connects Kubo by routed IP address, disables public bootstrap, mines through authenticated getblocktemplate routes, creates competing partition branches, and verifies higher-work convergence.

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

## resources

- [bun documentation](https://bun.sh/docs)
- [docker compose documentation](https://docs.docker.com/compose/)
- [Kubo documentation](https://docs.ipfs.tech/install/command-line/)
