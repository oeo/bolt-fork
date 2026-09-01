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

announcements are signed by the advertised node identity. validation first rejects oversized or malformed fields, then applies sender and aggregate verification limits before public-key and signature work. a separate aggregate limit charges only announcements that pass identity, chain, timestamp, and signature validation.

validated announcements enter a short-lived candidate table. repeat announcements can update candidate data but cannot extend its original residency deadline. candidate and durable peer tables use endpoint-prefix caps and replace the oldest entry from the most represented prefix when full. successful authenticated outbound tcp sessions promote candidates to the durable table with the resolved endpoint used by the connection. inbound sessions cannot provide an observed listening port, so they promote only when a matching candidate exists and retain its signed endpoint.

these limits preserve bounded and rotating discovery capacity. they do not prevent sybil identities. advertised height and tip hash do not determine chain selection.

configured static peers use `nodeId@host:port` and dial directly after the tcp listener starts. the signed handshake must authenticate the configured node id. static peers supplement ipfs discovery; they do not bypass transport authentication.

## tcp protocol

current protocol version is `6`.

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

each connection sends a signed `version`, then expects protocol version `6`. `version` binds protocol version, chain id, genesis hash, node id, public key, nonce, timestamp, user agent, and starting height. mismatched versions, stale timestamps, invalid signatures, and discovery identity mismatches are disconnected.

peers answer with a signed `verack` that binds both identities, both nonces, and connection roles. secp256k1 ecdh derives directional frame authentication keys. application messages are rejected until reciprocal authentication completes. duplicate identities resolve to one deterministic connection.

## active block synchronization

`SyncManager` owns protocol dispatch and active synchronization. each authenticated peer starts header discovery with an exponential block locator. advertised height and cumulative work are not trusted.

1. receiver sends `getheaders` with canonical locator hashes.
2. peer returns up to 2,000 contiguous headers after the first matching locator.
3. `Blockchain.validateHeaderChain()` finds a canonical ancestor and validates header hashes, linkage, proof of work, configured difficulty adjustment, median time, future time, and cumulative work.
4. equal-work or lower-work candidates stop without requesting block bodies.
5. receiver requests each full block only after candidate work exceeds current canonical work.
6. each response must match expected peer session, request deadline, and block hash.
7. canonical extensions pass through `Blockchain.addBlock()`. forks remain buffered until the complete validated branch passes `Blockchain.reorganize()`.
8. mempool synchronization starts after chain convergence.

network policy accepts at most 4,000 candidate headers across active peer requests and candidate body bytes totaling 16 configured maximum blocks. transaction body requests allow 500 globally and 50 per peer session. body download is sequential. reorganization has no fixed block-count limit, but the complete candidate must fit the byte bound. unsolicited blocks are ignored.

## inventory and transactions

new local blocks and transactions are announced with `inv`. `getdata` serves only inventory previously announced to that authenticated peer. received block inventory triggers header discovery instead of immediate body download.

unknown transaction inventory creates bounded, session-bound requests. matching `tx` responses pass through mempool validation once, then relay to peers other than the source. unsolicited transactions are ignored. mempool synchronization runs after header convergence.

## connection lifecycle

`ConnectionManager` listens with `Bun.listen`, opens outbound sockets with `Bun.connect`, parses fragmented and coalesced frames, queues partial writes, sends keepalives, and drops failed or unresponsive sockets. fresh discovery announcements and bounded deferred retries reconnect eligible peers.

connection admission limits aggregate, pending outbound, inbound, and per-source unauthenticated connections. per-endpoint and per-source attempt windows bound reconnect churn. pending dials are bounded and tied to one manager run, so late connections from an earlier run are rejected.

## transport security

chain-specific magic rejects frames for another configured network. checksum detects payload corruption. signed handshake transcripts authenticate node identity and chain membership. directional sequence numbers and authentication tags reject modification and replay after handshake.

payload, receive-buffer, send-buffer, handshake, and asynchronous dispatch limits are enforced before unbounded work occurs. mainnet and testnet outbound dialing rejects private, reserved, and non-global addresses after dns resolution. devnet permits private peers. transport payloads remain plaintext; authentication does not provide confidentiality.

authenticated dispatch charges one per-session token bucket before storage or validation handlers run. cost combines command weight, bounded collection count, and bounded payload size. one global bucket limits aggregate work across sessions. exhausted sessions disconnect. session state is removed on connection close, and all dispatch state is reset when synchronization stops.

## compose connectivity

main `docker-compose.yml` joins bolt and ipfs services to `bolt-network`. tcp port `8333` is published for peer traffic. api and metrics ports bind to host loopback. the default `NODE_HOST` is the docker hostname; cross-host deployments must set it to a routable address.

`docker-compose.bats.yml` gives each bolt node a separate Kubo daemon and Docker network. only a pinned router fixture joins both networks. tests install routes through that fixture, peer Kubo by routed IP address, mine through authenticated getblocktemplate routes, create competing partition branches, verify higher-work convergence, and disable public bootstrap. tcp port `8333` remains unpublished.

this topology verifies routed layer-3 discovery and data exchange on one Docker host. it does not test outbound NAT behavior or verify inbound NAT traversal, public firewall policy, internet routing, or cross-host deployment. a two-host deployment remains a release gate and requires operator-provided reachable hosts and routable `NODE_HOST` values.

## configuration

network startup reads these environment variables:

- `TCP_PORT`, tcp listen and announcement port.
- `STATIC_PEERS`, comma-separated `nodeId@host:port` identity-bound seed endpoints.
- `IPFS_API`, ipfs rpc endpoint.
- `IPFS_BOOTSTRAP_ENABLED`, defaults to `true`. this controls bolt's explicit fallback connections and does not modify Kubo's bootstrap list. isolated deployments must disable both.
- `NODE_HOST`, host placed in tcp peer announcements.

connection and sync tuning values are constructor options. they are not environment variables in current startup wiring.

## limits

- block body download is sequential.
- synchronization does not aggregate work across several peers.
- transport authentication does not provide confidentiality.
- checkpoints and finalized blocks are not implemented.
