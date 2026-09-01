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

the optional `miner` field is excluded from block hashing and consensus block-size measurement.

sha-256 is the only consensus hash.

block timestamps must be strictly greater than their parent block timestamp and greater than the median of the past 11 blocks.

## state transition

`executeBlock()` is the state transition function. it receives a block, touched parent accounts, parent state root, chain configuration, and block reward. it performs no storage writes.

execution validates transaction structure, chain id, transfer sender and recipient address prefixes, coinbase recipient address prefix, canonical compressed transfer public keys, signatures, nonce order, balances, coinbase position, coinbase value, timestamps, and transaction hash uniqueness. coinbase timestamp must equal block timestamp. transfer timestamps must not exceed block timestamp. output contains changed accounts, their previous values, and the next state root. storage commits output only after block validation succeeds.

transfer hashes commit to canonical signed fields, signature, and canonical compressed 33-byte public key. coinbase hashes commit to canonical unsigned fields.

state roots use sha-256 over length-prefixed fields under the `bolt:state-transition:v1` domain. input contains the parent state root followed by changed-account records sorted by address. every record contains address, resulting balance, resulting nonce, and a deletion marker. zero-balance zero-nonce results use the deletion marker and are not stored as accounts.

the root recursively authenticates ordered state evolution. it does not provide standalone account proofs.

## chainwork

block work is calculated from the proof-of-work target. cumulative work is the sum of exact block work, not the sum of displayed difficulty values. equal-work forks keep the current canonical chain.

## difficulty adjustment

difficulty adjustment uses integer arithmetic. non-genesis epochs contain the configured number of blocks. for testnet, blocks 1 through 60 form the first epoch and block 61 receives the first adjusted difficulty. adjustment measures the 59 timestamp gaps, uses the first block's difficulty as the base, and clamps elapsed time to a 4x increase or 1/4 decrease. there is no timeout minimum-difficulty exception.

## limits

total UTF-8 serialized consensus block size must not exceed configured `maxBlockSize`. `miner` metadata is excluded. `maxTransactionSize` and `minFeePerByte` govern mempool admission and reorganization restoration, not block validity.

## genesis

genesis uses fixed millisecond timestamps, configured nonce and difficulty, empty transaction merkle root, and empty account state root. every shipped nonce satisfies proof of work at its current configured difficulty. startup validates configured genesis before storage writes and rejects stored genesis that differs from configuration. persisted stores carry storage version and chain id metadata. nodes reject data from older schemas or another chain.

mainnet startup is disabled until launch difficulty is selected. current mainnet difficulty is not a launch decision. pre-alpha testnet uses a calibrated 60,000,000 bootstrap difficulty and a fresh genesis nonce; public canary measurement may require another reset before identity freeze.

## issuance

genesis issues no currency. reward at a target height is calculated after exact rewards for heights `1` through `target - 1`. halving uses integer division by powers of two. issuance stops when reward reaches zero or maximum supply is reached.

## reorganization

storage persists each canonical block's changed accounts and previous values. reorganization reads only accounts touched by detached blocks, replacement blocks, or affected mempool transactions. persisted undo restores ancestor values before replacement blocks apply. median time and difficulty use candidate branch history. one canonical storage transition replaces detached blocks, indexes, changed accounts, mempool entries, tip metadata, and cumulative work.

the storage transition compares expected tip hash, height, and cumulative work inside the same transaction as all writes. stale writers cannot overwrite a newer chain. block admission uses one process-local write queue, while storage compare-and-swap protects shared persistence.

confirmed transfers leave the mempool in the same transaction that indexes their block. removing or expiring a transfer also removes its sender's nonce descendants. a reorganization removes replacement-chain transfers, validates detached transfers against replacement account state and active mempool policy in sender and nonce order, then restores valid transfers with durable arrival times. in-memory mempool state changes only after persistence commits.

active network synchronization does not impose a fixed block-count reorganization limit. complete candidate bodies remain bounded by configured byte capacity and are applied only after the candidate has greater validated cumulative work. checkpoints and finalized blocks are not implemented.
