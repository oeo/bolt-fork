# bolt consensus

bolt uses proof of work with account state. consensus follows the valid chain with the greatest cumulative work.

## block commitment

each block hash commits to:

- height
- timestamp
- previous block hash
- transaction merkle root
- account state root
- difficulty
- proof-of-work nonce

the optional `miner` field is excluded from block hashing. it remains part of serialized block size and can affect `maxBlockSize` validation.

sha-256 is the only consensus hash.

block timestamps must be strictly greater than their parent block timestamp and greater than the median of the past 11 blocks.

## state transition

`executeBlock()` is the state transition function. it receives a block, complete parent account state, chain configuration, and block reward. it performs no storage writes.

execution validates transaction structure, chain id, transfer sender and recipient address prefixes, coinbase recipient address prefix, signatures, nonce order, balances, coinbase position, coinbase value, coinbase timestamp, and transaction hash uniqueness. the coinbase timestamp must equal the block timestamp. output contains complete resulting account state and its root. storage commits output only after block validation succeeds.

transfer hashes commit to canonical signed fields and the signature. coinbase hashes commit to canonical unsigned fields.

state roots sort addresses by ascii value. each address, balance, and nonce uses length-prefixed utf-8 encoding under the `bolt:state:v1` domain before sha-256 hashing.

## chainwork

block work is calculated from the proof-of-work target. cumulative work is the sum of exact block work, not the sum of displayed difficulty values. equal-work forks keep the current canonical chain.

## limits

total UTF-8 serialized block size must not exceed configured `maxBlockSize`. `maxTransactionSize` and `minFeePerByte` govern mempool admission and reorganization restoration, not block validity.

## genesis

genesis uses fixed millisecond timestamps, configured nonce and difficulty, empty transaction merkle root, and empty account state root. persisted stores carry storage version and chain id metadata. nodes reject data from older schemas or another chain.

## reorganization

reorganization rebuilds account state at the common ancestor and executes the full replacement branch before persistence. median time and difficulty use the candidate branch history. one canonical storage transition then replaces detached blocks, block and transaction indexes, complete account state, mempool entries, tip metadata, and cumulative work.

the storage transition compares expected tip hash, height, and cumulative work inside the same transaction as all writes. stale writers cannot overwrite a newer chain. block admission uses one process-local write queue, while storage compare-and-swap protects shared persistence.

confirmed transfers leave the mempool in the same transaction that indexes their block. removing or expiring a transfer also removes its sender's nonce descendants. a reorganization removes replacement-chain transfers, validates detached transfers against replacement account state and active mempool policy in sender and nonce order, then restores valid transfers with durable arrival times. in-memory mempool state changes only after persistence commits.

bounded reorganization depth, checkpoints, and finalized blocks are not implemented yet.
