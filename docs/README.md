# Documentation

| Document | What it is | Read it when |
| --- | --- | --- |
| [constitution.md](constitution.md) | Binding architecture, domain and engineering principles | Before your first pull request, and whenever you are tempted to break one |
| [technology-baseline.md](technology-baseline.md) | Every version in use, why it was chosen, when to revisit | Before adding or upgrading a dependency |
| [design-foundation.md](design-foundation.md) | Palette, tokens and accessibility commitments derived from `logo.png` | Before building any screen |
| [adr/](adr/) | Architecture decision records | When you want to know *why*, or are about to change a decision |

## Architecture decision records

| ADR | Decision |
| --- | --- |
| [ADR-0001](adr/ADR-0001-modular-monolith.md) | Modular monolith for the V1 backend |
| [ADR-0002](adr/ADR-0002-mobile-architecture.md) | Feature-first mobile architecture with inward dependencies |
| [ADR-0003](adr/ADR-0003-postgresql-postgis.md) | PostgreSQL + PostGIS as the geospatial core |
| [ADR-0004](adr/ADR-0004-data-access.md) | Drizzle ORM with node-postgres |
| [ADR-0005](adr/ADR-0005-riverpod.md) | Riverpod for composition, DI and state — not as architecture |
| [ADR-0006](adr/ADR-0006-api-contract-strategy.md) | Generated OpenAPI as the API contract |
| [ADR-0007](adr/ADR-0007-typescript-esm-toolchain.md) | ESM, TypeScript 6 and Vitest for the API |
| [ADR-0008](adr/ADR-0008-authentication-session-model.md) | Account, credential, profile and session as separate concerns |
| [ADR-0009](adr/ADR-0009-refresh-token-rotation.md) | Single-use refresh rotation with database-enforced concurrency |
| [ADR-0010](adr/ADR-0010-place-geospatial-model.md) | `geography(Point, 4326)` as the spatial source of truth |
| [ADR-0011](adr/ADR-0011-mapbox-mobile-integration.md) | Mapbox for rendering, Trilha for Places |

## Writing an ADR

One file per decision, named `ADR-NNNN-short-slug.md`, containing:

```
Context       — the forces at play, with evidence
Decision      — what we chose, stated plainly
Alternatives  — what else was considered, and why it lost
Consequences  — what this costs us, including the risks we accepted
Status        — Proposed | Accepted | Superseded by ADR-NNNN
```

Record the decision when it is made, not after. An ADR written to justify a choice
already shipped is a summary, not a decision record.
