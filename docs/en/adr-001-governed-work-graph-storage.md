# ADR 001: Keep the Governed Work Graph in transactional stores

| Item | Decision |
|---|---|
| Status | Accepted for the V2.3 workspace candidate; not committed, pushed, or deployed |
| Date | 2026-08-12 |
| Scope | Graph Contract v1 append-only projections, four bounded explanations, and the personal project cockpit |

## Context

Foursday's authoritative facts already live in project manifests, recipes, tasks, plans, steps, approvals, capability budgets, evidence, memory, triggers, and time-return ledgers. The governed graph explains relationships between those facts. It must not become a second authorization system or replace the domain state machines.

The design must preserve these invariants:

- reachability never grants authority and the domain ledger still consumes budgets atomically;
- every traversal is limited to one tenant and one project, with explicit depth and result bounds;
- runtime observations are append-only, replay is idempotent, and privacy erasure removes graph records inside the domain erasure transaction;
- SQLite and PostgreSQL implement the same contract;
- capture fails closed before an external effect and terminal state can be replayed deterministically from domain truth.

## Options

| Option | Benefit | Cost and risk |
|---|---|---|
| SQLite/PostgreSQL projection | Reuses transactions, encryption, isolation, backup, migration, and erasure controls | Best for bounded traversal; open-ended graph analysis would increase query complexity |
| Dedicated graph database | Native multi-hop traversal and graph analytics | Adds dual-write, authorization, backup, key, erasure, migration, and operational failure modes |
| Transactional store plus asynchronous graph replica | Separates domain writes from graph reads | Requires an outbox, replay, reconciliation, and deletion propagation before it can be trusted |

## Decision

Graph Contract v1 remains an encrypted append-only projection in SQLite for local use and PostgreSQL for the production shape. Foursday does not add a dedicated graph database or a second source of truth.

Domain records commit first and are projected from stable domain revisions. Intended graph capture must persist before a plan may start an external effect. If terminal capture fails after an effect, the executor replays it from the persisted domain update timestamp. Stable node and edge identities make exact replay idempotent. This domain-replay plus fail-closed execution gate avoids rolling back a completed external effect merely because its explanatory projection was temporarily unavailable.

The four explanation queries remain application-level and are limited to one tenant, one project, depth 8, and 500 nodes or edges. Every answer is marked non-authoritative and points authorization, budget, approval, and execution decisions back to domain services.

## Evidence

The 2026-08-12 workspace candidate produced this evidence:

- `npm run check:full`: 665 tests passed across SQLite and an isolated temporary PostgreSQL instance, with no failures or skips.
- `npm run graph:benchmark`: 30 plans, 242 nodes, 331 edges, and 100 iterations. On the local SQLite candidate, storage reads plus all four explanations measured 19.015 ms P50, 22.114 ms P95, and 26.918 ms maximum.
- Negative tests cover stale authorization, recipe drift, cross-project memory, missing approval/source/evidence, concurrent append, replay idempotency, and privacy erasure.

This is a local candidate benchmark, not a production SLO and not evidence for unbounded traversal.

## Revisit triggers

Re-evaluate a dedicated graph database or asynchronous replica only when one of these is demonstrated:

1. production-shaped, privacy-safe data repeatedly pushes the four bounded queries above 100 ms P95 under the same encryption and isolation controls;
2. an online product requirement genuinely needs more than 500 results or depth 8 and cannot be satisfied by a precomputed projection;
3. a graph-analysis use case becomes materially harder to maintain in the transactional model, rather than merely easier to visualize;
4. the project has an explicit operating budget for dual-write reconciliation, erasure propagation, backup/restore, tenant isolation, and failure drills.

Until then, a graph database adds risk without improving the core personal AI work system.
