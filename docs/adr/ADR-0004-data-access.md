# ADR-0004 — Drizzle ORM with node-postgres for data access

**Status:** Accepted (PR-00, 2026-09-04)

## Context

The data access layer must serve a PostGIS-centric domain. Evaluated against the
criteria in the PR-00 brief: PostgreSQL support, PostGIS/geospatial support, migrations,
type safety, a SQL escape hatch, active maintenance, NestJS/Node compatibility, and
production predictability.

The decisive criterion is spatial capability. A layer that makes `ST_*`, GIST indexes or
`EXPLAIN ANALYZE` awkward would turn Trilha's central feature into permanent friction
(constitution §4).

## Decision

**Drizzle ORM 0.45.2** over **node-postgres (`pg`) 8.23.0**.

- Migrations are **plain `.sql` files** applied by Drizzle's migrator. They are readable,
  reviewable, hand-editable, and — critically — survive replacing Drizzle itself.
- `sql` template literals are treated as a first-class tool, not an escape hatch of last
  resort. Spatial queries are written as SQL where SQL is clearer.
- `drizzle-kit` **generates** migrations; it never mutates a live schema
  (constitution §23).
- `pg` rather than `postgres.js`: explicit pool control makes connection lifecycle,
  timeouts and health probing straightforward, and it is the more conservative choice
  for a production connection pool.

## Alternatives

- **Prisma.** Rejected on the decisive criterion: PostGIS types are `Unsupported()`,
  which excludes them from the typed API and forces `$queryRaw` for exactly the queries
  that matter most. Optimising for the 20% of queries that are trivial while
  handicapping the 80% that are spatial is the wrong trade for this product.
- **TypeORM.** Rejected: has geometry support, but a history of unreliable migration
  generation, a `synchronize` footgun that constitution §23 forbids, and heavier
  decorator-driven entities.
- **Kysely.** Genuinely close, and stronger on pure query-building ergonomics. Rejected
  narrowly: no schema-as-source-of-truth and no migration generation, so the schema
  would live only in hand-written migrations. Drizzle offers the same SQL transparency
  *and* a typed schema the domain PRs will build on.
- **Raw `pg` with hand-written SQL only.** Rejected: maximum transparency, but no type
  safety across a growing schema, and every join becomes a manual mapping.

## Consequences

- Spatial SQL is written directly, indexed properly, and inspectable with
  `EXPLAIN ANALYZE`. An integration test asserts this remains true.
- Migrations are plain SQL, so a future migration away from Drizzle does not require
  rewriting schema history.
- **Risk: Drizzle is pre-1.0** (0.45.2) and a 1.0 beta line exists. Constitution §26
  keeps us on the stable release. The exposure is bounded because migrations are plain
  SQL and the `sql` escape hatch is portable; a replacement would touch query call
  sites, not the schema history. Revisit when Drizzle 1.0 is stable.
- **Known dev-only advisory:** `drizzle-kit` depends transitively on `esbuild ≤0.24.2`
  (dev-server CORS advisory). It is a `devDependency`, absent from the production image,
  and drizzle-kit never starts an esbuild dev server. `npm audit --omit=dev` reports
  zero vulnerabilities. Tracked as `TECHNICAL_DEBT`; resolves when drizzle-kit 1.0 ships.
