# ADR-0001 — Modular monolith for the V1 backend

**Status:** Accepted (PR-00, 2026-09-04)

## Context

Trilha V1 spans identity, places, trails, routing, ratings, safety, events and AI
suggestions. The domain boundaries between them are genuinely unclear today — in
particular where Place ends and Trail begins, and how Safety relates to Rating. The
team is small and there is no production traffic to scale for.

Choosing a distributed architecture now would fix those boundaries at the exact moment
we understand them least, and every future correction would become a cross-service
migration.

## Decision

One deployable NestJS application, internally organised as modules under `src/modules/`,
with shared technical capability in `src/infrastructure/` and `src/common/`.

Boundaries are enforced by module structure and code review. A module owns its data;
cross-module access goes through the owning module's public surface, not through
another module's tables.

## Alternatives

- **Microservices from day one.** Rejected: pays full distributed-systems cost
  (latency, partial failure, deploy orchestration, distributed debugging) to buy
  independence we cannot yet use, and freezes boundaries prematurely.
- **Serverless functions.** Rejected: PostGIS work needs warm, pooled connections;
  per-invocation connection churn is a poor fit, and cold starts hurt map interactions.
- **Unstructured monolith.** Rejected: without internal boundaries the code becomes a
  ball of mud, and extraction later becomes impossible rather than merely costly.

## Consequences

- One build, one deploy, one log stream, one debugger. Fast iteration.
- A transaction can span what will later be separate contexts. This is a genuine
  hazard: crossing module boundaries inside a transaction must stay a review concern.
- Scaling is horizontal-whole-app only. Acceptable at V1 volume.
- Extraction stays possible because modules own their data. Constitution §2 requires
  proven need before anyone attempts it.
