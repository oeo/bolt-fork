# networking

bolt separates peer discovery from blockchain data exchange.

```text
ipfs pubsub: peer endpoint discovery
tcp: handshake, inventory, blocks, and transactions
```

## peer discovery

`PeerDiscoveryService` connects to an ipfs rpc endpoint, attempts public libp2p bootstrap nodes as fallback connectivity, and subscribes to `/bolt/<chainId>/<genesisHash>/peers/<PROTOCOL_VERSION>`. ipfs carries endpoint announcements only.

announcements contain:

- `nodeId`
- `publicKey`
- `tcp`
- `height`
- `tipHash`
- `chainId`
- `genesisHash`
- `version`
- `timestamp`
- optional `capabilities`
- `signature`

announcements are signed by the advertised node identity. validation binds the public key to `nodeId`, checks chain identity, bounds fields and sender rates, and accepts bracketed ipv6 endpoints. fresh announcements update the complete peer record and trigger bounded connection attempts. stale announcements are removed. peer selection currently compares announced height only.

## tcp protocol

current protocol version is `5`.

```text
[magic:4][type:4][length:4][checksum:4][sequence:8][authentication-tag:32][payload:length]
```

- `magic` identifies bolt protocol traffic and is derived from `chainId`.
- `type` identifies protocol message.
- `length` declares payload bytes.
- `checksum` is first four bytes of double sha-256 over payload.
- `sequence` is a directional session sequence number.
- `authentication-tag` is hmac-sha-256 over the complete frame with an empty tag field.
- `payload` contains message-specific bytes.

the protocol serializes handshake, keepalive, inventory, block request, header request, block, and transaction messages. transaction payloads include `chainId` and `kind`. inventory, locator, and header decoders reject collections above protocol limits.

## handshake

each connection sends a signed `version`, then expects protocol version `5`. `version` binds protocol version, chain id, genesis hash, node id, public key, nonce, timestamp, user agent, and starting height. mismatched versions, stale timestamps, invalid signatures, and discovery identity mismatches are disconnected.

peers answer with a signed `verack` that binds both identities, both nonces, and connection roles. secp256k1 ecdh derives directional frame authentication keys. application messages are rejected until reciprocal authentication completes. duplicate identities resolve to one deterministic connection.

## active block synchronization

active sync is sequential and height-selected:

1. discovery chooses peer with highest announced height.
2. sync sends `getblocks` to that peer.
3. block locator contains current tip and genesis. genesis is omitted when it is already tip.
4. peer returns block hashes through `inv`.
5. receiver requests unknown block hashes through `getdata`.
6. peer sends full `block` messages.
7. receiver accepts only next expected height and validates block through `Blockchain.addBlock()`.

sync retries timed-out batches against same target. it does not compare announced or downloaded cumulative work before selecting target. consensus code validates each block and local fork reorganization, but active network sync is not a validated cumulative-work sync protocol.

`getheaders` and `headers` codecs and responder paths exist. active sync does not request or consume headers. `BlockDownloader` also exists, but active sync does not queue inventory through it or dispatch received blocks to it. headers-first and parallel block sync are therefore not implemented.

## inventory and transactions

new local blocks and transactions can be announced with `inv`. peers can request advertised items with `getdata`. block requests are served. transaction relay can serve requested local mempool transactions.

incoming `tx` messages decode at protocol layer but are not dispatched to `TransactionRelay.handleTransaction()`. incoming transaction admission and relay are not active. `syncMempool()` exists but is not called when peers connect.

## connection lifecycle

`ConnectionManager` listens with `Bun.listen`, opens outbound sockets with `Bun.connect`, parses fragmented and coalesced frames, queues partial writes, sends keepalives, and drops failed or unresponsive sockets. fresh discovery announcements and bounded deferred retries reconnect eligible peers.

connection admission limits aggregate, pending outbound, inbound, and per-source unauthenticated connections. per-endpoint and per-source attempt windows bound reconnect churn. pending dials are bounded and tied to one manager run, so late connections from an earlier run are rejected.

## transport security

chain-specific magic rejects frames for another configured network. checksum detects payload corruption. signed handshake transcripts authenticate node identity and chain membership. directional sequence numbers and authentication tags reject modification and replay after handshake.

payload, receive-buffer, send-buffer, handshake, and asynchronous dispatch limits are enforced before unbounded work occurs. mainnet and testnet outbound dialing rejects private, reserved, and non-global addresses after dns resolution. devnet permits private peers. transport payloads remain plaintext; authentication does not provide confidentiality.

## compose connectivity

main `docker-compose.yml` joins bolt and ipfs services to `bolt-network`. bolt advertises its docker hostname for peer discovery when `NODE_HOST` is set by compose. tcp port `8333` is reachable inside docker network but is not published to host. api and metrics ports are published separately.

`docker-compose.bats.yml` also leaves tcp port `8333` unpublished. deployment tests reach services through compose networking or published api port, not host tcp.

## configuration

network startup reads these environment variables:

- `NETWORK_MODE`, defaults to `tcp`. legacy `ipfs` mode falls back to tcp mode.
- `TCP_PORT`, tcp listen and announcement port.
- `IPFS_API`, ipfs rpc endpoint.
- `NODE_HOST`, host placed in tcp peer announcements.

connection and sync tuning values are constructor options. they are not environment variables in current startup wiring.

## unimplemented network paths

- headers-first sync
- parallel block downloading in active sync
- cumulative-work peer selection and validated cumulative-work sync
- incoming transaction dispatch
- mempool sync on connection
- requested block admission outside active sequential sync
