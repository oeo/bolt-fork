# bolt architecture

## overview

bolt is a proof-of-work blockchain with account state. peer discovery and blockchain data use separate transports:

1. ipfs pubsub announces peer tcp endpoints.
2. tcp carries protocol messages, blocks, and transactions.

the ipfs discovery service attempts public libp2p bootstrap nodes before subscribing to a chain- and protocol-scoped topic. blockchain data does not travel through ipfs.

## consensus

bolt consensus uses sha-256 only. every shipped chain configuration selects sha-256, and `Blockchain` rejects any other configured or requested consensus hash algorithm. the general crypto helper exposes other algorithms, but they are not valid bolt consensus choices.

block acceptance validates:

- block structure, proof of work, and configured size limit
- parent linkage and expected difficulty
- median time against recent blocks
- transaction execution and resulting account state root
- account balances and nonces

canonical storage tracks cumulative work. competing branches can trigger a reorganization only after candidate blocks, state transitions, difficulty, timestamps, and cumulative work are validated. network synchronization validates candidate headers and cumulative work before requesting block bodies.

## networking

active networking uses protocol version `6`.

```text
ipfs pubsub discovery -> tcp connection -> version/verack -> getheaders -> headers -> getdata -> block
```

peer announcements include signed node identity, chain identity, tcp endpoint, height, tip hash, version, timestamp, and capabilities. discovered peers are connected over tcp. fresh announcements can retry disconnected peers within connection admission and cooldown limits.

signed `version` and `verack` transcripts bind both peers, connection roles, nonces, protocol version, chain id, and genesis hash. secp256k1 ecdh derives directional hmac-sha-256 frame keys. authenticated frames carry monotonic sequence numbers. transport payloads are not encrypted.

tcp input, output, connection, handshake, message-dispatch, discovery, and protocol collection limits bound peer-controlled resource use. authenticated dispatch uses weighted per-session and aggregate work buckets before storage and validation. discovery keeps signed announcements in expiring prefix-diverse candidate capacity until authenticated tcp success promotes them. these controls limit resource use but do not prevent sybil identities. mainnet and testnet outbound dialing rejects private and reserved destinations after dns resolution. devnet permits private peers.

`SyncManager` owns authenticated protocol dispatch. active synchronization sends `getheaders` with an exponential canonical locator, validates contiguous headers and cumulative work through `Blockchain`, then requests candidate block bodies sequentially. canonical extensions use normal block admission. complete replacement branches use bounded reorganization. block inventory starts header discovery rather than direct body download.

transaction inventory creates bounded requests tied to the authenticated peer session. requested transactions pass through mempool admission once and relay without echoing to their source. unsolicited blocks and transactions are ignored. see [networking](networking.md) for protocol limits.

## account state

accounts contain:

- address
- balance
- nonce

transactions are chain-bound and identify transfer or coinbase kind. block execution reads touched accounts, derives updates and undo values, and commits a recursive transition root with each accepted block. zero-balance zero-nonce accounts are deleted canonically.

## storage

`StorageAdapter` defines block, account, transaction, mempool, metadata, and canonical-chain operations. implementations are:

- `LMDBAdapter` for persistent storage
- `MemoryAdapter` for in-memory use

canonical transitions carry expected tip, cumulative-work values, and per-block account updates with undo values. storage implementations reject stale writes instead of silently replacing a changed tip. memory and LMDB apply changed accounts only. LMDB commits blocks, indexes, account changes, undo records, mempool changes, tip metadata, and cumulative work in one transaction. startup verifies chain specification, configured genesis, every canonical block and state root, final account state, cumulative work, and confirmed transaction locations before serving traffic.

the cold storage command snapshots LMDB through its supported backup operation. backups include node identity and a chain manifest. restore requires a stopped node and empty destination, verifies a staged copy, then renames it into place. online restore is not supported.

confirmed transaction lookup returns transaction location and current canonical height from one storage snapshot. canonical transitions rebuild or update transaction locations when branches change.

## runtime structure

```text
src/core/       blocks, blockchain, execution, difficulty, forks, mempool, transactions
src/crypto/     hashes, addresses, keys, signatures, wallets
src/storage/    storage contract, lmdb implementation, memory implementation
src/network/    discovery, tcp framing, connections, sync, inventory, relay
src/services/   mining, block templates, metrics
src/api/        bun http server
src/config/     chain configuration
src/utils/      logging, serialization, identity, currency
```

bun runs typescript directly. tcp uses `Bun.listen` and `Bun.connect`. hashing uses `Bun.CryptoHasher` without unsupported performance multipliers or benchmark claims.

`src/index.ts` owns fallback miner, getblocktemplate, and api composition. fallback mining requires configured active-network payout. optional mining routes share getblocktemplate service, require bearer token, and are disabled by default.

## current network limits

- block body download is sequential.
- candidate headers, reorganization depth, requested transactions, and candidate body bytes have fixed policy bounds.
- synchronization evaluates one peer candidate at a time.
- checkpoints and finalized blocks are not implemented.

tcp framing checks chain-specific network magic, payload checksum, sequence, and authentication tag. signed handshakes authenticate peer identity. transport does not provide confidentiality.

main compose networking keeps tcp port `8333` inside `bolt-network`. it does not publish that port to the host.
