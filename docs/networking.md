# networking

bolt separates peer discovery from blockchain data exchange.

```text
ipfs pubsub: peer endpoint discovery
tcp: handshake, inventory, blocks, and transactions
```

## peer discovery

`PeerDiscoveryService` connects to an ipfs rpc endpoint, attempts public libp2p bootstrap nodes as fallback connectivity, and subscribes to `/bolt/peers`. ipfs carries endpoint announcements only.

announcements contain:

- `nodeId`
- `tcp`
- `height`
- `chainHash`
- `version`
- `timestamp`
- optional `capabilities`

received announcements are validated, stored by node id, and used to open tcp connections. stale announcements are removed. peer selection currently compares announced height only.

## tcp protocol

current protocol version is `4`.

```text
[magic:4][type:4][length:4][checksum:4][payload:length]
```

- `magic` identifies bolt protocol traffic. configured networks currently share it, so it does not isolate chains.
- `type` identifies protocol message.
- `length` declares payload bytes.
- `checksum` is first four bytes of double sha-256 over payload.
- `payload` contains message-specific bytes.

the protocol serializes handshake, keepalive, inventory, block request, header request, block, and transaction messages. transaction payloads include `chainId` and `kind`.

## handshake

each connection sends `version`, then expects protocol version `4`. mismatched versions are disconnected. accepted versions receive `verack`.

version messages carry services, timestamp, peer addresses, nonce, user agent, and starting height. current handshake does not authenticate node identity or bind discovery `nodeId` to tcp peer identity.

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

`ConnectionManager` listens with `Bun.listen`, opens outbound sockets with `Bun.connect`, buffers fragmented messages, emits complete frames, and drops idle or failed sockets. failed peers are not automatically reconnected.

outbound connection attempts observe one aggregate connection setting. inbound accepts do not enforce aggregate or inbound-specific caps.

## transport security

magic rejects non-bolt frames. configured networks currently share the same magic. checksum detects payload corruption. neither mechanism authenticates sender, isolates chains, or encrypts transport.

declared payload length is trusted before a complete frame is emitted. no payload cap or receive-buffer cap is enforced. inbound connections have no enforced cap. unauthenticated peer identity and unbounded transport input remain release blockers.

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
- automatic reconnect
- payload and receive-buffer caps
- inbound connection caps
