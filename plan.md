# bolt remediation plan

current focus: preserve completed consensus, persistence, networking, dependency, api, and deployment release gates before adding protocol features.

## status

resolved audit findings:

- [x] bind transaction public keys to sender addresses
- [x] require exactly one coinbase transaction at index zero
- [x] enforce byte-accurate consensus block size limits
- [x] consolidate storage adapter contracts
- [x] make normal block commits atomic
- [x] restore clean typechecking
- [x] repair the test compose overlay
- [x] enforce typecheck, test, and docker smoke ci gates
- [x] replace vulnerable cryptography and kubo client dependencies
- [x] bind canonical transaction signatures and hashes to chain identity
- [x] execute block state transitions through one pure executor
- [x] commit deterministic account state roots
- [x] use deterministic genesis blocks and exact target-derived chainwork
- [x] restrict consensus proof of work to sha-256
- [x] make extension and reorganization expected-tip atomic transitions
- [x] serialize canonical block admission
- [x] validate mempool transactions against canonical and pending account state
- [x] persist confirmed transaction indexes and mempool lifecycle state
- [x] make block-template payout, state root, and submission results authoritative

open release gates:

- [x] bind peer handshakes and traffic to chain identity
- [x] authenticate and bound tcp transport
- [x] relay transactions and synchronize by validated cumulative work
- [x] harden api input, exposure, pagination, and metric labels
- [x] pin deployment inputs
- [x] pass real multi-node deployment tests

## sequence

1. establish honest typecheck, unit, integration, and docker smoke gates
2. replace vulnerable cryptography and kubo dependencies
3. add chain-bound canonical transaction encoding
4. unify block execution, state roots, deterministic genesis, and chainwork
5. move all canonical writes behind one atomic storage transition
6. unify mempool and block-template admission and lifecycle ownership
7. authenticate and bound peer transport
8. centralize protocol dispatch, relay, inventory, and synchronization
9. remove obsolete peer http routes and harden remaining api routes
10. complete deployment tests, reproducible builds, cleanup, and documentation

smart contracts and private transactions remain out of scope until separately designed and reviewed.
