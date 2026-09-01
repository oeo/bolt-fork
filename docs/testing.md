# testing

bolt uses bun test suites for unit, integration, and end-to-end behavior. bats covers deployment smoke tests against docker environments.

## test layers

- unit tests isolate consensus, protocol, storage, and utility behavior.
- integration tests verify boundaries between bolt components.
- end-to-end tests verify complete application flows in bun.
- a bun integration test opens authenticated tcp connections between two nodes and verifies block synchronization and transaction relay.
- network unit tests cover authenticated command flooding, refill, session isolation, aggregate work exhaustion, invalid discovery floods, and bounded rotation across thousands of accepted candidate identities.
- bats places two deployed nodes and their Kubo daemons on separate Docker networks joined only by a pinned router fixture. it mines through authenticated getblocktemplate routes and verifies routed endpoint announcements, non-genesis block synchronization, pending transaction relay, competing partition branches, higher-work convergence, router interruption and restoration, SIGKILL recovery, persistence, and cold backup restore.
- bun network tests verify that a candidate over 100 blocks can replace a lower-work branch while remaining inside the candidate body-byte limit.
- cross-host connectivity remains a release gate. local Docker routing does not test outbound NAT or prove public routing, firewall behavior, or inbound NAT traversal.
- docker coverage belongs in bats, not bun suites.
- bun integration coverage sends `SIGKILL` at an LMDB canonical-transition boundary and accepts only complete pre-transition or post-transition state after restart.

## local checks

run bun tests with bail enabled:

```bash
bun test --bail
```

run type checking:

```bash
bun run typecheck
bun run typecheck:scripts
bun run test:dormant
```

run deployment smoke tests:

```bash
bun run test:bats
```

audit dependencies:

```bash
bun audit
```

## continuous integration

ci performs these gates:

1. install dependencies from the frozen lockfile.
2. typecheck source and maintained scripts.
3. reject dormant `.disabled` and `.skip` files.
4. audit dependencies.
5. run bun tests with a timeout and bail on first failure.
6. run a ten-minute-bounded bats deployment test.

only active suites contribute to these gates. report test totals, coverage, or performance only from current generated output.
