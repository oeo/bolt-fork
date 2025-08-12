# development

## prerequisites

- bun 1.0+ (no node.js required)
- docker & docker compose
- ipfs daemon (optional, for local testing)
- 2gb ram minimum
- 10gb disk space

## setup

### clone repository
```bash
git clone https://github.com/yourusername/bolt-ts.git
cd bolt-ts
```

### install dependencies
```bash
bun install
```

### environment configuration
```bash
# copy example environment
cp .env.example .env

# edit configuration
vim .env
```

key environment variables:
```bash
# network selection
BOLT_NETWORK=devnet        # mainnet, testnet, devnet

# node configuration
NODE_ID=dev-node-1         # unique node identifier
NETWORK_MODE=tcp           # tcp (ipfs mode deprecated)

# storage
STORAGE_TYPE=lmdb          # lmdb or memory
LMDB_PATH=/data/lmdb       # lmdb data directory
LMDB_MAP_SIZE=107374182400 # 100gb default

# networking
API_PORT=7333              # rest api port
TCP_PORT=8333              # p2p tcp port
METRICS_PORT=7336          # prometheus metrics

# ipfs (for peer discovery)
IPFS_API=http://localhost:5001

# mining
ENABLE_MINING=true
MINER_ADDRESS=<your-address>

# logging
LOG_LEVEL=info             # debug, info, warn, error
```

## running locally

### single node
```bash
# start all services with docker
docker-compose up -d

# or run directly with bun
bun run src/index.ts
```

### multi-node cluster
```bash
# launch 3-node cluster
bun run scripts/launch-cluster.ts 3

# launch with clean data
bun run scripts/launch-cluster.ts 3 --clean

# stop cluster
bun run scripts/stop-cluster.ts 3
```

### monitoring
```bash
# view logs
docker-compose logs -f bolt

# check metrics
curl http://localhost:7336/metrics

# api status
curl http://localhost:7333/
```

## project structure

```
bolt-ts/
├── src/
│   ├── core/           # blockchain, mempool, transactions
│   ├── crypto/         # cryptography and addresses
│   ├── storage/        # storage adapters
│   ├── network/        # p2p networking
│   ├── services/       # mining, metrics
│   ├── api/            # rest api
│   ├── config/         # chain configurations
│   ├── utils/          # utilities
│   └── index.ts        # entry point
├── tests/
│   ├── unit/           # unit tests
│   ├── integration/    # integration tests
│   └── setup.ts        # test configuration
├── scripts/
│   ├── launch-cluster.ts    # multi-node launcher
│   ├── stop-cluster.ts      # cluster shutdown
│   └── generate-wallet.ts   # wallet generator
├── docker/
│   └── node*/          # node configurations
└── docs/               # documentation
```

## development workflow

### making changes
1. create feature branch
2. make changes
3. run tests
4. update documentation
5. submit pull request

### running tests
```bash
# all tests
bun test

# unit tests only
bun test tests/unit

# specific test
bun test tests/unit/protocol.test.ts

# with coverage
bun test --coverage
```

### code style
- typescript with strict mode
- 2-space indentation
- no semicolons (optional)
- functional style preferred
- async/await over promises

### commit conventions
```
feat: add new feature
fix: fix bug
docs: update documentation
test: add tests
refactor: refactor code
perf: performance improvement
chore: maintenance
```

## debugging

### logging
```typescript
import { getLogger } from './utils/logger';

const logger = getLogger(__filename);
logger.debug('debug message');
logger.info('info message');
logger.warn('warning message');
logger.error('error message');
```

### debugging with vscode
```json
{
  "type": "bun",
  "request": "launch",
  "name": "Debug Bolt",
  "program": "${workspaceFolder}/src/index.ts",
  "cwd": "${workspaceFolder}",
  "env": {
    "LOG_LEVEL": "debug"
  }
}
```

### debugging tests
```bash
# run with inspector
bun test --inspect

# attach debugger
chrome://inspect
```

## common tasks

### generate wallet
```bash
bun run scripts/generate-wallet.ts
```

### create genesis block
```bash
bun run scripts/create-genesis.ts
```

### benchmark mining
```bash
bun run scripts/benchmark-mining.ts
```

### analyze chain
```bash
bun run scripts/analyze-chain.ts
```

## architecture overview

### core components
- **blockchain**: manages chain state and validation
- **mempool**: transaction pool management
- **block**: block structure and validation
- **transaction**: transaction creation and verification

### networking
- **tcp protocol**: binary message protocol
- **peer discovery**: ipfs-based discovery
- **sync manager**: blockchain synchronization
- **connection manager**: tcp connection handling

### storage
- **lmdb adapter**: production storage
- **memory adapter**: testing storage
- **storage interface**: common api

### services
- **mining service**: block production
- **getblocktemplate**: mining pool protocol
- **metrics service**: prometheus metrics

## testing guidelines

### unit tests
- test individual functions
- mock external dependencies
- fast execution (<1ms)
- high coverage (>90%)

### integration tests
- test component interactions
- use real storage
- test full flows
- validate edge cases

### e2e tests
- multi-node scenarios
- network synchronization
- fork resolution
- attack scenarios

## performance considerations

### optimizations
- use bun native features
- minimize allocations
- batch operations
- parallel processing
- efficient serialization

### benchmarks
- block validation: <10ms
- transaction signing: <1ms
- hash rate: >1m/sec
- sync speed: ~1000 blocks/min

## deployment

### docker
```bash
# build image
docker build -t bolt-node .

# run container
docker run -d \
  -p 7333:7333 \
  -p 8333:8333 \
  -p 7336:7336 \
  -v ./data:/data \
  bolt-node
```

### kubernetes
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bolt-node
spec:
  replicas: 3
  selector:
    matchLabels:
      app: bolt
  template:
    metadata:
      labels:
        app: bolt
    spec:
      containers:
      - name: bolt
        image: bolt-node:latest
        ports:
        - containerPort: 7333
        - containerPort: 8333
        - containerPort: 7336
```

## troubleshooting

### sync issues
- check ipfs connectivity
- verify tcp ports open
- ensure peers have blocks
- check network selection

### performance issues
- increase lmdb map size
- reduce connection limit
- enable connection pooling
- optimize logging level

### storage issues
- check disk space
- verify permissions
- backup lmdb regularly
- monitor database size

## contributing

### code review
- all changes require review
- tests must pass
- documentation required
- follow style guide

### release process
1. update version
2. update changelog
3. run full test suite
4. tag release
5. build docker image
6. deploy to network

## resources

- [bitcoin developer guide](https://developer.bitcoin.org/)
- [bun documentation](https://bun.sh/docs)
- [lmdb documentation](http://www.lmdb.tech/doc/)
- [ipfs documentation](https://docs.ipfs.io/)