# ADR-0003 — PostgreSQL + PostGIS as the geospatial core

**Status:** Accepted (PR-00, 2026-09-04)

## Context

Trilha is a geospatial product. Its core queries are "places near this point",
"trails intersecting this area", "distance along this route" — spatial predicates over
indexed geometry, not incidental lat/lng columns.

Storage must therefore provide real spatial indexing, geodesic distance on an
ellipsoid, and an inspectable query planner. Getting this wrong is not a performance
detail: it determines whether the product's central feature is viable.

## Decision

**PostgreSQL 18 with PostGIS 3.6**, one database serving both relational and spatial
workloads.

- `geography(Point, 4326)` for real-world distance, where PostGIS computes on the
  ellipsoid — a naive Euclidean distance over degrees is wrong at Brazil's latitudes.
- GIST indexes on every spatial column that is filtered.
- The extension is enabled by an explicit migration
  (`0000_enable_postgis.sql`), not by an image entrypoint, so a managed PostgreSQL
  (RDS, Cloud SQL) provisions identically to local Docker.

## Alternatives

- **PostgreSQL without PostGIS, using lat/lng columns and Haversine in SQL.**
  Rejected: no spatial index, so every proximity query is a full scan; no polygon or
  intersection support; correctness degrades away from the equator.
- **A dedicated geospatial store (Elasticsearch geo, MongoDB 2dsphere) alongside
  PostgreSQL.** Rejected: two sources of truth for the same entity, dual-write
  consistency problems, and the operational cost of a second datastore — for
  capability PostGIS already exceeds.
- **PostgreSQL 19.** Rejected: beta at time of writing; constitution §26 forbids
  pre-release without justification, and there is none.

## Consequences

- One database, one transaction boundary, one backup and restore story: a Place and its
  geometry are written atomically.
- The team must know PostGIS. Spatial SQL is a real skill, and reviewing a spatial
  query requires reading its plan.
- SRID discipline is required. Mixing `geometry` and `geography`, or mismatched SRIDs,
  produces silently wrong distances — an integration test asserts a known
  São Paulo→Rio distance precisely to catch this class of error.
- PostgreSQL is now on the critical path for the product's core feature, which is why
  readiness probes it and refuses traffic without it.
