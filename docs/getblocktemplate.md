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

## external hashing

template `version: 1` uses sha-256 over this utf-8 string with no prefix or newline:

```text
height:timestamp:previousHash:merkleRoot:stateRoot:difficulty:nonce
```

decimal integers contain no padding. hashes are 64-character lowercase hexadecimal strings. nonce range is `0` through `9007199254740991`. a solution is valid when the unsigned 256-bit block hash is less than or equal to template `target`.

fixed vector:

```text
preimage = 1:1700000001001:0000000000000000000000000000000000000000000000000000000000000000:1111111111111111111111111111111111111111111111111111111111111111:2222222222222222222222222222222222222222222222222222222222222222:100000:42
sha256   = 648b51f2920ff55c2b45c15c503958b03cf27baaebed6e45c5b2747cade6349d
```

sha-256 is the only supported consensus algorithm. another algorithm requires an explicit network or hard-fork rule and a new template version.

## api

mining routes are disabled by default:

- `POST /mining/template`
- `POST /mining/submit`

enabling requires `MINING_API_ENABLED=true` and non-empty `MINING_API_TOKEN`. requests use `Authorization: Bearer <token>`. comparison hashes both values and uses constant-time byte comparison. server bounds body size, active mining requests, submission rate, job count, identifiers, and numeric fields.
