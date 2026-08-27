# getblocktemplate

`GetBlockTemplateService` creates payout-specific proof-of-work jobs from canonical chain state and current mempool transactions.

## candidate construction

fallback mining and getblocktemplate use one candidate builder. caller must provide payout address valid for active network.

candidate construction:

1. selects executable sender heads by fee per byte, arrival, then hash through deterministic binary max-heap
2. preserves nonce order within each sender queue
3. creates coinbase from current reward and selected fees
4. executes complete block to derive state root
5. measures serialized consensus envelope with maximum safe nonce and 64-character hash
6. removes only selection suffix while oversized, then rebuilds coinbase, merkle root, state root, and fee totals

reported `blockSizeBytes` is exact measured envelope size. optional `miner` metadata remains outside consensus size.

## jobs and longpoll

jobs live in process memory. service retains at most ten jobs. jobs expire after 30 seconds. restart discards them.

first request with new `longpollId` returns current template. repeated unchanged request waits up to 60 seconds. block or mempool change wakes matching payout subscription with rebuilt template.

## submission

submission accepts bounded UUID template ID, safe non-negative nonce, and optional exact template timestamp. service reconstructs prepared header, validates proof of work, and calls `Blockchain.addBlock()`.

## API

mining routes are disabled by default:

- `POST /mining/template`
- `POST /mining/submit`

enabling requires non-empty `MINING_API_TOKEN`. requests use `Authorization: Bearer <token>`. comparison hashes both values and uses constant-time byte comparison. server bounds body size, active mining requests, submission rate, job count, identifiers, and numeric fields.
