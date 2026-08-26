# getblocktemplate

`GetBlockTemplateService` creates payout-specific proof-of-work jobs from canonical chain state and current mempool transactions.

## request

each request requires `payoutAddress`. the address must match the active chain prefix. cached templates are scoped by payout address so work for one miner cannot pay another miner.

longpoll requests also carry the payout address and previous `longpollId`. first use primes the payout-to-template mapping and returns immediately. a repeated request with an unchanged ID waits. canonical chain changes wake payout-scoped subscriptions.

## prepared header

template generation:

1. reads current tip and expected difficulty
2. selects mempool transactions
3. creates a valid coinbase paying requested address
4. constructs block with one timestamp
5. executes block against current account state
6. commits resulting state root into template header

template exposes previous hash, merkle root, state root, timestamp, difficulty, target, coinbase, transactions, and fee totals. the proof-of-work preimage contains exactly `height`, `timestamp`, `previousHash`, `merkleRoot`, `stateRoot`, `difficulty`, and `nonce`. transactions commit indirectly through the merkle and state roots.

## submission

submission reconstructs exact prepared header, assigns submitted nonce, calculates block hash, checks proof of work, and calls `Blockchain.addBlock()`. submitted timestamp is optional. when present, it must equal template timestamp.

service returns blockchain validation result. an exact duplicate already canonical submission is idempotently valid. stale competing submissions reject. accepted template transactions leave the mempool in the canonical storage transition.

## lifecycle

templates refresh after 30 seconds and disappear after a cleanup sweep. the interval is not a strict submission expiry. custom storage keys hold serialized templates, active IDs, payout-scoped current IDs, cleanup sets, mempool hash, and longpoll state. template publication and cleanup are serialized with canonical state writes.

significant mempool changes invalidate active templates and regenerate work for each active payout address. shutdown clears cleanup, watcher, and longpoll timers.
