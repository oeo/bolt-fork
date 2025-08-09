# bolt

`bolt` is a proof-of-work blockchain with an account-based model, using "watts" as its base unit.

## Currency

- **Symbol**: BOLT
- **Base unit**: watt (W)
- **Precision**: 1 BOLT = 100,000,000 watts (8 decimal places)
- **Max supply**: 21,000,000 BOLT (2.1 quadrillion watts)
- **Initial reward**: 50 BOLT per block
- **Halving**: Every 210,000 blocks

## Current status

Phase 1 complete - Core blockchain implementation with account model, HD addresses, and transaction processing.
Currently working on Phase 2 - Transaction ecosystem and mempool.

## Quick start

```bash
# start the development environment
docker-compose up -d

# view logs
docker-compose logs -f

# stop services
docker-compose down
```

## Services

- Redis: `localhost:7337`
- Prometheus: `localhost:7338`
- Loki: `localhost:7339`
- Grafana: `localhost:7340` (admin/admin)

## Architecture

- **Consensus**: Proof-of-work with cumulative difficulty (highest work wins)
- **Account model**: Balance and nonce tracking (no UTXOs)
- **Address format**: Bitcoin-style base58 addresses with HD key support
- **HD derivation**: BIP44 path `m/44'/1057'/account'/change/index` (coin type 1057)
- **Storage**: Redis with swappable adapters
- **Runtime**: Bun (TypeScript runs directly, no compilation)
- **Networking**: libp2p with gossipsub

## Development

See [plan.md](plan.md) for the detailed implementation roadmap.

## Configuration

Bolt uses a two-tier configuration system:

### Chain Configuration
Consensus parameters are defined in TypeScript files under `src/config/chains/`:
- `mainnet.ts` - Production network configuration
- `testnet.ts` - Test network with faster blocks
- `devnet.ts` - Local development with minimal difficulty

Select network via `BOLT_NETWORK` environment variable (default: mainnet).

### Operational Settings
Node operation settings via environment variables:
- `BOLT_NETWORK` - Network to use (mainnet/testnet/devnet)
- `STORAGE_TYPE` - Storage backend (redis/memory)
- `REDIS_URL` - Redis connection string
- `API_PORT`, `P2P_PORT`, `WS_PORT` - Service ports
- `LOG_LEVEL` - Logging verbosity
- `ENABLE_MINING` - Enable/disable mining
- `MINER_ADDRESS` - Address for mining rewards

## Testing

```bash
bun test              # unit tests
bun test:integration  # integration tests
bun test:e2e         # end-to-end tests
```
