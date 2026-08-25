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

sha-256 is the only consensus hash.

## state transition

`executeBlock()` is the state transition function. it receives a block, complete parent account state, chain configuration, and block reward. it performs no storage writes.

execution validates transaction structure, chain id, address prefixes, signatures, nonce order, balances, coinbase position, and coinbase value. output contains complete resulting account state and its root. storage commits output only after block validation succeeds.

state roots sort addresses by ascii value. each address, balance, and nonce uses length-prefixed utf-8 encoding under the `bolt:state:v1` domain before sha-256 hashing.

## chainwork

block work is calculated from the proof-of-work target. cumulative work is the sum of exact block work, not the sum of displayed difficulty values. equal-work forks use the lower tip hash as deterministic tie-breaker where fork comparison has both hashes.

## genesis

genesis uses fixed millisecond timestamps, configured nonce and difficulty, empty transaction merkle root, and empty account state root. persisted stores carry storage version and chain id metadata. nodes reject data from older schemas or another chain.

## reorganization

reorganization rebuilds account state at the common ancestor and executes the full replacement branch before persistence. median time and difficulty use the candidate branch history. one canonical storage transition then replaces detached blocks, block indexes, complete account state, tip metadata, and cumulative work.

the storage transition compares expected tip hash, height, and cumulative work inside the same transaction as all writes. stale writers cannot overwrite a newer chain. block admission uses one process-local write queue, while storage compare-and-swap protects shared persistence.

bounded reorganization depth, checkpoints, and finalized blocks are not implemented yet.
