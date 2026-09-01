# bolt development plan

status reviewed 2026-08-31 after two adversarial passes. current work follows the minimal stability path.

## completed stability gates

implemented:

- [x] headers-first sync is the sole remote fork owner; transient `ForkManager` and dead selection facade removed
- [x] reorganization has no fixed block-count limit and no genesis-to-ancestor work scan
- [x] a candidate over 100 blocks reorganizes within the body-byte limit
- [x] getblocktemplate v1 has an exact external hash preimage and fixed vector
- [x] simultaneous solutions serialize through canonical block admission
- [x] static identity-bound seed peers supplement ipfs discovery
- [x] fallback typescript mining is disabled in deployment tests; bats mines through getblocktemplate
- [x] obsolete scripts and dormant test files removed; ci checks scripts, dormant files, and dependencies
- [x] node container runs unprivileged with an allowlist build context
- [x] unsupported ipfs/hybrid network modes removed
- [x] testnet uses non-genesis 60-block bigint difficulty epochs and a newly mined 60M-difficulty genesis
- [x] public API exposes chain identity, fee policy, stable rejection codes, and mempool-aware account state
- [x] reference testnet wallet creates encrypted keystores, signs locally, and rejects wrong-chain endpoints
- [x] single-worker SQLite faucet persists prepared transactions and bounds cooldowns, queue, and daily payouts
- [x] explicit testnet reset clears chain state while preserving node identity
- [x] direct node startup requires explicit network selection and candidate genesis hash is pinned by test
- [x] Kubo pubsub uses supported configuration instead of deprecated daemon flag
- [x] consensus status includes state root; metrics distinguish accepted, locally mined, and reorganized blocks
- [x] protocol v7 requests mempool inventory explicitly after authenticated chain convergence
- [x] ordinary Compose nodes publish no p2p ports and emit no endpoint announcement
- [x] seed override explicitly publishes bolt and Kubo TCP/UDP ports
- [x] static peers retry through existing connection admission and cooldown behavior
- [x] deployed Bats proves advertising-seed to non-advertising-edge sync and peer direction

## open findings

critical:

- [ ] benchmark the selected external miner on launch hardware; reset and re-mine genesis if the 60M candidate difficulty misses the 30-second bootstrap target materially

high:

- [ ] run a real two-host testnet trial with routable tcp endpoints and redundant Kubo peers
- [ ] measure large LMDB canonical transitions before raising the candidate body-byte limit
- [ ] mine a release candidate through height 61 and verify first retarget independently

medium:

- [ ] source protocol/package/discovery versions independently: unify software display/UA version only; PROTOCOL_VERSION stays wire-bound (m8, do not merge)
- [ ] drop chainwork gauge or clamp it; exact bigint cannot be a prometheus gauge value (m12)

deferred (not now; no demonstrated bug, 37 active fixture call sites):

- [ ] restrict canonical storage mutation to transition contract (m14)

low:

- [ ] bunfig cache path (l1), obsolete .env.test vars (l2), grafana secret (l3), bats image cleanup (l4)

## forward development (revised order)

1. pass the deterministic deployed getblocktemplate partition/reorganization gate repeatedly.
2. run a two-host public-routing trial and measure discovery, sync, relay, restart, and Kubo interruption.
3. select and freeze the testnet launch package from measured behavior.
4. launch testnet and soak it before smart-contract implementation.
5. smart contracts and private transactions stay out of scope until separately designed and reviewed; private tx also requires an encrypted transport threat model.

known deliberate limits: consensus/p2p decoupling boundary is unnamed; validateHeaderChain/addBlock/reorganize live in one blockchain.ts. accepted as v1 non-goal, documented here so it stays a decision not a drift.
