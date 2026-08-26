# testing

bolt uses bun test suites for unit, integration, and end-to-end behavior. bats covers deployment smoke tests against docker environments.

## test layers

- unit tests isolate consensus, protocol, storage, and utility behavior.
- integration tests verify boundaries between bolt components.
- end-to-end tests verify complete application flows in bun.
- bats currently starts one deployed node and verifies genesis persistence across restart. multi-node communication coverage remains a release gate.
- docker coverage belongs in bats, not bun suites.

suites stored with `.disabled` or `.skip` names are dormant. they do not run and are not release gates.

## local checks

run bun tests with bail enabled:

```bash
bun test --bail
```

run type checking:

```bash
bun run typecheck
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
2. run type checking.
3. run bun tests with a timeout and bail on first failure.
4. run bats deployment smoke tests.

only active suites contribute to these gates. report test totals, coverage, or performance only from current generated output.
