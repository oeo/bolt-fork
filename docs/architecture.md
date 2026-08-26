# bolt architecture

## overview

bolt is a proof-of-work blockchain with account state. peer discovery and blockchain data use separate transports:

1. ipfs pubsub announces peer tcp endpoints.
2. tcp carries protocol messages, blocks, and transactions.

the ipfs discovery service attempts public libp2p bootstrap nodes before subscribing to `/bolt/peers`. blockchain data does not travel through ipfs.

## consensus

bolt consensus uses sha-256 only. every shipped chain configuration selects sha-256, and `Blockchain` rejects any other configured or requested consensus hash algorithm. the general crypto helper exposes other algorithms, but they are not valid bolt consensus choices.

block acceptance validates:

- block structure, proof of work, and configured size limit
- parent linkage and expected difficulty
- median time against recent blocks
- transaction execution and resulting account state root
- account balances and nonces

canonical storage tracks cumulative work. competing branches can trigger a reorganization only after candidate blocks, state transitions, difficulty, timestamps, and cumulative work are validated. this local fork handling is separate from network synchronization. network sync does not select or prevalidate peers by cumulative work.

## networking

active networking uses protocol version `4`.

```text
ipfs pubsub discovery -> tcp connection -> version/verack -> getblocks -> inv -> getdata -> block
```

peer announcements include node id, tcp endpoint, height, chain hash, version, timestamp, and optional capabilities. discovered peers are connected over tcp.

active synchronization selects the announced peer with highest height. it sends `getblocks` with a locator containing current tip and genesis, receives `inv`, requests missing blocks with `getdata`, and accepts the next expected block sequentially.

`getheaders` and `headers` codecs and the `getheaders` responder exist. incoming `headers` messages are not dispatched. `BlockDownloader` exists, but active sync does not queue work through it. see [networking](networking.md) for protocol and release limitations.

## account state

accounts contain:

- address
- balance
- nonce

transactions are chain-bound and identify transfer or coinbase kind. block execution derives account updates and commits a state root with each accepted block.

## storage

`StorageAdapter` defines block, account, transaction, mempool, metadata, and canonical-chain operations. implementations are:

- `LMDBAdapter` for persistent storage
- `MemoryAdapter` for in-memory use

canonical transitions carry expected tip and cumulative-work values. storage implementations reject stale writes instead of silently replacing a changed tip. automatic backup, recovery, and startup integrity verification are not provided. `Blockchain.verifyChainIntegrity()` is an explicit operation.

## runtime structure

```text
src/core/       blocks, blockchain, execution, difficulty, forks, mempool, transactions
src/crypto/     hashes, addresses, keys, signatures, wallets
src/storage/    storage contract, lmdb implementation, memory implementation
src/network/    discovery, tcp framing, connections, sync, inventory, relay
src/services/   mining, block templates, metrics, service sync
src/api/        bun http server
src/config/     chain configuration
src/utils/      logging, serialization, identity, currency
```

bun runs typescript directly. tcp uses `Bun.listen` and `Bun.connect`. hashing uses `Bun.CryptoHasher` without unsupported performance multipliers or benchmark claims.

## current network gaps

these paths are not implemented end to end:

- headers-first synchronization
- parallel block downloading in active sync
- cumulative-work peer selection and validated cumulative-work network sync
- incoming `tx` dispatch to transaction relay
- mempool synchronization on connection
- automatic peer reconnection
- tcp payload and receive-buffer caps
- inbound connection caps

tcp framing checks network magic and payload checksum. it does not authenticate peers or encrypt traffic. unbounded transport input and unauthenticated peer identity remain release blockers.

main compose networking keeps tcp port `8333` inside `bolt-network`. it does not publish that port to the host.
