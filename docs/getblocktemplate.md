# getblocktemplate

`GetBlockTemplateService` creates payout-specific proof-of-work jobs from canonical chain state and current mempool transactions.

## request

each request requires `payoutAddress`. the address must match the active chain prefix. cached templates are scoped by payout address so work for one miner cannot pay another miner.

longpoll requests also carry the payout address and previous `longpollId`.

## prepared header

template generation:

1. reads current tip and expected difficulty
2. selects mempool transactions
3. creates a valid coinbase paying requested address
4. constructs block with one timestamp
5. executes block against current account state
6. commits resulting state root into template header

template exposes previous hash, merkle root, state root, timestamp, difficulty, target, coinbase, transactions, and fee totals. miners hash these exact fields with submitted nonce.

## submission

submission reconstructs exact prepared header, assigns nonce and optional timestamp, calculates block hash, checks proof of work, and calls `Blockchain.addBlock()`.

service returns blockchain validation result. rejected or stale blocks are never reported as accepted. accepted template transactions are removed from mempool and active templates are invalidated.

## lifecycle

templates expire after 30 seconds. custom storage keys hold serialized templates, active IDs, payout-scoped current IDs, expiry sets, mempool hash, and longpoll state.

significant mempool changes invalidate active templates and regenerate work for each active payout address. shutdown clears cleanup, watcher, and longpoll timers.
