---
name: perform-audit
description: Performs comprehensive repository audits when an operator requests audit all, maturity assessment, release readiness, security review, or a safety gate before adding consensus-critical features.
---

# Perform Audit

Produce evidence-backed repository audit covering correctness, security, architecture, persistence, networking, testing, deployment, dependencies, and maturity.

Assume monk tools are available. Refuse audit if required repository-mapping and source-ingestion tools are unavailable.

## Safety

- Remain read-only during audit.
- Never install, update, format, or modify dependencies.
- Never alter source, configuration, lockfiles, tests, or existing worktree changes.
- Run only safe verification commands.
- Apply project timeout and bail requirements to tests.
- Exclude dependency caches, generated files, and vendored code from source findings unless dependency risk itself is finding.
- Do not create audit file without explicit operator approval.

## Identity

Determine exact model ID before auditing.

Use model ID supplied by runtime when available. If unknown, ask operator:

> What model ID should this audit record?

Do not guess model identity.

Create model slug by:

1. Removing provider prefix.
2. Converting to lowercase.
3. Replacing dots, slashes, underscores, and spaces with hyphens.
4. Collapsing repeated hyphens.

Example:

`openai/gpt-5.6-sol` becomes `gpt-5-6-sol`.

## Meditation

Before audit:

1. Run `monk_tree` on repository.
2. Read project skills.
3. Read root and scoped `AGENTS.md` or `CLAUDE.md`.
4. Recall recent reflection commits when supported.
5. Read `cur.md` when present.
6. Gauge context size before ingestion.
7. Select largest safe importance threshold from printed histogram.
8. Ask operator before central ingestion exceeding about 150k tokens.
9. Use scoped monk agents when complete coverage exceeds central context.
10. Record selected threshold, estimated tokens, covered paths, and exclusions.

Read repository-owned source, contracts, callers, tests, manifests, deployment files, and colocated documentation needed to verify each finding.

## Audit Dimensions

Cover every applicable dimension:

- `gate`: crashes, consensus failure, corruption, loss of funds, remote termination.
- `sec`: authorization, authentication, cryptography, replay, resource exhaustion, unsafe exposure, dependency advisories.
- `bugs`: wrong behavior, races, null access, stale state, ignored results, invalid assumptions.
- `perf`: unbounded work, quadratic processing, uncontrolled memory, cardinality growth, blocking operations.
- `arch`: conflicting contracts, duplicate stacks, layer violations, missing ownership boundaries.
- `debt`: obsolete paths, disabled systems, placeholders, stale documentation, missing migrations.
- `smell`: deep control flow, ambiguous contracts, swallowed errors, state spread across layers.
- `split`: modules with multiple unrelated responsibilities that obstruct verification.
- `mod`: consequential outdated runtime patterns, not stylistic preference.
- `drift`: duplicated configuration, environment names, protocol constants, versions, documentation claims.
- `tests`: active, skipped, disabled, empty, flaky, missing integration, missing property or fuzz coverage.
- `deployment`: reproducibility, health checks, ports, secrets, persistence, restart behavior, multi-node operation.
- `maturity`: prototype, pre-alpha, alpha, beta, release candidate, or production-ready.

Skip dimensions with no consequential findings.

## Delegation

Partition independent scopes when needed:

- consensus, transactions, cryptography, and chain configuration
- networking, peer discovery, protocol, synchronization, and API
- storage, state transitions, reorganization, mining, and services
- tests, Docker, Compose, scripts, CI, dependencies, and documentation
- architecture, drift, dead paths, and source-of-truth conflicts

Each delegated agent must meditate on its scope before auditing. Agents return evidence with file and line references. Main agent deduplicates reports and resolves disagreements.

## Verification

Run applicable safe checks without mutation:

- tests with required bail flag and timeout
- coverage
- typecheck
- dependency audit
- Docker or Compose configuration validation
- active, skipped, disabled, and empty-test inventory
- deterministic in-memory probes for suspected correctness failures
- startup or storage smoke checks when safe

Record exact command, exit status, and observed result.

Passing tests do not override demonstrated defects.

## Findings

Report findings first, ordered critical, high, medium, low.

Use one-line schema:

```text
c1  path:line[, path:line]  critical: observable problem. required fix direction.
h1  path:line[, path:line]  high: observable problem. required fix direction.
m1  path:line[, path:line]  medium: observable problem. required fix direction.
l1  path:line[, path:line]  low: observable problem. required fix direction.
```

Severity meanings:

- critical: loss of funds, arbitrary minting or spending, consensus divergence, persistent corruption, remote code execution, or reliable remote node termination.
- high: exploitable wrong behavior, unavailable production path, serious denial of service, broken recovery, or absent release gate.
- medium: consequential maintainability, performance, lifecycle, drift, or test deficiency.
- low: bounded inconsistency with real operational cost.

Do not report formatting preferences or generic best practices.

Merge duplicate symptoms under root cause. Preserve strongest evidence and all relevant locations.

## Maturity

Assess these areas separately:

| Area | Expected assessment |
|---|---|
| core primitives | correctness and behavioral coverage |
| transaction authorization | ownership, signatures, replay, nonce rules |
| consensus | deterministic validation and fork choice |
| state and persistence | atomicity, recovery, schema, state commitments |
| networking | identity, framing, limits, discovery, synchronization |
| deployment | reproducibility, health, persistence, interoperability |
| testing | unit, integration, multi-node, adversarial, fuzzing |
| release process | CI, typecheck, audit, coverage, artifacts |
| requested feature | prerequisites and blockers |

Give one overall maturity verdict. Production-ready requires all critical and high findings resolved with executable gates.

## Audit Artifact

After presenting audit results, determine current date and propose:

`audits/MM-DD-YYYY-<model-slug>.md`

Example:

`audits/06-25-2025-gpt-5-6-sol.md`

If filename exists, propose numeric suffix:

`audits/06-25-2025-gpt-5-6-sol-02.md`

Ask operator exactly:

> Write this audit to `<proposed-path>`?

Do not create directory or file until operator explicitly approves.

## Artifact Schema

Use this exact structure:

````markdown
---
schema: bolt.audit.v1
audited_at: YYYY-MM-DD
model_id: provider/model
model_slug: model-slug
repository: owner/name
commit: full-commit-sha
branch: branch-name
scope: all
meditation_min: number
coverage: description
worktree: clean-or-dirty
---

# Audit: repository-name

## Verdict

Overall maturity: maturity-level

Release decision: blocked-or-approved

Requested-feature decision: blocked-or-approved, with short reason

## Critical Findings

```text
c1  path:line  critical: problem. fix direction.
```

## High Findings

```text
h1  path:line  high: problem. fix direction.
```

## Medium Findings

```text
m1  path:line  medium: problem. fix direction.
```

## Low Findings

```text
l1  path:line  low: problem. fix direction.
```

Omit empty severity sections.

## Maturity

| Area | Maturity | Evidence |
|---|---|---|
| core primitives | level | concise evidence |
| transaction authorization | level | concise evidence |
| consensus | level | concise evidence |
| state and persistence | level | concise evidence |
| networking | level | concise evidence |
| deployment | level | concise evidence |
| testing | level | concise evidence |
| release process | level | concise evidence |
| requested feature | ready-or-blocked | concise evidence |

## Verification

| Command | Exit | Result |
|---|---:|---|
| `command` | code | exact result |

## Required Gates

1. First independently verifiable gate.
2. Second independently verifiable gate.

## Coverage

State mapped file count, ingested scopes, meditation threshold, delegated scopes, and known exclusions.

## Limitations

State unavailable tooling, commands not run, environment constraints, and assumptions. Write `None.` when no limitations remain.
````

## Writing

After approval:

1. Recheck proposed path does not exist.
2. Create `audits/` only when needed.
3. Write artifact using native file-edit tool.
4. Preserve audit exactly as presented unless operator requests revision.
5. Reread file and validate schema fields.
6. Report written path.
7. Do not commit unless operator explicitly requests reflection.

## Completion

Final response states:

- overall maturity
- release decision
- requested-feature decision
- verification summary
- audit coverage
- artifact status and path, when written
