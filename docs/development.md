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

## single node

The compose stack starts bolt, Kubo, and monitoring services.

compose publishes api, metrics, Prometheus, and Grafana to host loopback. tcp p2p and ipfs swarm ports publish on all host interfaces for peer connectivity. the api remains unauthenticated, and Grafana uses default `admin` credentials unless configured otherwise. Kubo rpc remains inside the docker network. set `NODE_HOST` to a routable address before connecting nodes across hosts.

```bash
docker compose up -d
docker compose logs -f bolt
docker compose down
```

To run bolt directly, start Kubo first and set `IPFS_API` to its api address:

```bash
bun run src/index.ts
```

## multi-node deployment test

`docker-compose.bats.yml` starts two bolt nodes with separate Kubo daemons. the test connects those daemons explicitly and disables public bootstrap so discovery does not depend on internet peers.

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
