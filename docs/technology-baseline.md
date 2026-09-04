# Technology baseline

**Verified at: 2026-09-04**

Every version below was checked against its upstream registry at implementation time
(npm registry, pub.dev, nodejs.org, Docker Hub, the Flutter release channel) — not
assumed, not carried over from a template. Constitution §25.

Re-verify this table at the start of each dependency review and update
`Verified at`.

---

## Runtime and language

| Technology | Latest stable (2026-09-04) | Selected | Source | Reason |
| --- | --- | --- | --- | --- |
| Node.js | 26.8.1 (Current) / **24.20.0 (LTS)** | **24.20.0 LTS** | nodejs.org/dist | Production runtimes track LTS. Node 26 is Current, not yet LTS; Node 25 is an ended Current line. Pinned in `.nvmrc` and the Dockerfile. |
| TypeScript | 7.0.2 | **6.0.3** | npm | TS 7 is excluded by `typescript-eslint` (`<6.1.0`) and `ts-jest` (`<7`). 6.0.3 is the highest stable inside every peer range. See ADR-0007. |
| Dart | 3.13.2 | **3.13.2** | Flutter SDK | Bundled with Flutter stable. |
| Flutter | 3.47.2 | **3.47.2** | Flutter stable channel | Latest stable. Local SDK was upgraded from 3.44.2 during PR-00. |

> **Local-environment note.** The development machine runs Node v25.1.0, an ended
> Current line, while CI and the container use 24.20.0 LTS. `package.json` declares
> `engines.node >= 24`; `.nvmrc` pins 24.20.0. Tracked as `TECHNICAL_DEBT`: align the
> local runtime to LTS.

## Backend

| Technology | Latest stable | Selected | Source | Reason |
| --- | --- | --- | --- | --- |
| NestJS (`@nestjs/core`, `common`, `platform-express`) | 12.0.1 | **12.0.1** | npm | Latest stable. ESM-only — see ADR-0007. |
| `@nestjs/config` | 12.0.0 | **12.0.0** | npm | Matches the Nest major. |
| `@nestjs/swagger` | 12.0.1 | **12.0.1** | npm | OpenAPI generation (ADR-0006). |
| Drizzle ORM | 0.45.2 | **0.45.2** | npm | Latest stable; 1.0 is beta and excluded by constitution §26. ADR-0004. |
| drizzle-kit | 0.31.10 | **0.31.10** | npm | Migration generation only. |
| `pg` (node-postgres) | 8.23.0 | **8.23.0** | npm | Explicit pool control. ADR-0004. |
| ioredis | 6.0.0 | **6.0.0** | npm | Latest stable Redis client. |
| Zod | 4.5.4 | **4.5.4** | npm | Config validation and request validation — one validator, not two. |
| Pino / nestjs-pino / pino-http | 10.3.1 / 5.1.0 / 11.0.0 | **same** | npm | Structured logging with sink-level redaction. |
| Helmet | 8.3.0 | **8.3.0** | npm | Security headers. |
| OpenTelemetry SDK / auto-instrumentations / OTLP HTTP exporter | 0.222.0 / 0.80.0 / 0.222.0 | **same** | npm | Opt-in tracing. The OTel JS SDK is pre-1.0 by upstream convention; this is its stable release line. |
| Sentry | 10.73.0 | **`@sentry/node` 10.73.0** | npm | `@sentry/nestjs@10` declares a peer of NestJS 8–11 and does **not** support NestJS 12. The framework-agnostic SDK has no peer conflict and is wired at the infrastructure boundary only. |

## Backend tooling

| Technology | Latest stable | Selected | Source | Reason |
| --- | --- | --- | --- | --- |
| ESLint | 10.9.1 | **10.9.1** | npm | Latest stable. |
| typescript-eslint | 8.69.0 | **8.69.0** | npm | Type-aware linting; constrains the TypeScript choice (ADR-0007). |
| Prettier | 3.9.6 | **3.9.6** | npm | Formatting gate. |
| Vitest / `@vitest/coverage-v8` | 5.0.0 | **5.0.0** | npm | Native ESM support; replaces Jest (ADR-0007). |
| `unplugin-swc` / `@swc/core` | 1.5.11 / 1.16.1 | **same** | npm | Emits `emitDecoratorMetadata` for Nest DI under Vitest. |
| supertest | 7.2.2 | **7.2.2** | npm | HTTP-level integration tests. |

## Data and infrastructure

| Technology | Latest stable | Selected | Source | Reason |
| --- | --- | --- | --- | --- |
| PostgreSQL | 18.6 (19 is beta) | **18.6** | Docker Hub `postgis/postgis` | Latest stable major. PostgreSQL 19 is beta — excluded by constitution §26. |
| PostGIS | 3.6.4 | **3.6.4** | Docker Hub | Ships with the `18-3.6-alpine` image. |
| Redis | 8.10.1 | **8.10-alpine** | Docker Hub | Latest stable. |
| Docker image (API) | node:24.20.0-alpine3.24 | **same** | Docker Hub | Matches the Node LTS pin. |

> **PostgreSQL 18 image change.** From version 18 the official images store data in a
> major-version subdirectory; the volume must mount at `/var/lib/postgresql`, **not**
> the pre-18 `/var/lib/postgresql/data`. Mounting the old path makes the container
> refuse to start. `infra/local/docker-compose.yml` uses the correct path.

## Mobile

| Technology | Latest stable | Selected | Source | Reason |
| --- | --- | --- | --- | --- |
| flutter_riverpod | 3.4.3 | **3.4.3** | pub.dev | Composition and DI (ADR-0005). |
| go_router | 18.0.1 | **18.0.1** | pub.dev | Declarative routing, deep-link ready. |
| dio | 5.11.1 | **5.11.1** | pub.dev | HTTP client with interceptors, typed errors, cancellation. |
| equatable | 2.1.0 | **2.1.0** | pub.dev | Value equality without hand-written `==`. |
| flutter_lints | 6.0.0 | **6.0.0** | pub.dev | Lint baseline, extended in `analysis_options.yaml`. |

## CI

| Action | Selected | Reason |
| --- | --- | --- |
| `actions/checkout` | v6 | Latest major. |
| `actions/setup-node` | v6 | Latest major; built-in npm cache. |
| `actions/upload-artifact` | v5 | Latest major. |
| `subosito/flutter-action` | v2 | The maintained standard for Flutter in Actions. |

Actions are pinned by major tag. Tightening to commit SHAs is tracked as
`TECHNICAL_DEBT` for the PR that introduces deployment credentials, where the supply-chain
exposure becomes material.

---

## Pre-release versions in use

**None.** No alpha, beta, RC, canary or nightly dependency is used anywhere in this
baseline, so constitution §26 requires no exception.

Pre-release versions that were available and deliberately **rejected**:
PostgreSQL 19 (beta), Drizzle ORM 1.0 (beta), TypeScript 7.1 (dev).

## Known deviations from "latest"

| Item | Latest | Using | Why | Resolves when |
| --- | --- | --- | --- | --- |
| TypeScript | 7.0.2 | 6.0.3 | `typescript-eslint` and `ts-jest` exclude TS 7 (ADR-0007) | `typescript-eslint` ships a stable TS 7 peer range |
| Node.js | 26.8.1 | 24.20.0 | Production tracks LTS, not Current | Node 26 enters LTS (expected Oct 2026) |
| Drizzle ORM | 1.0.0-beta | 0.45.2 | Constitution §26 forbids beta | Drizzle 1.0 stable |
| Sentry for Nest | `@sentry/nestjs` 10.73.0 | `@sentry/node` 10.73.0 | `@sentry/nestjs` does not support NestJS 12 | `@sentry/nestjs` adds a NestJS 12 peer |
