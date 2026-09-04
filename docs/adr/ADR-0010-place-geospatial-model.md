# ADR-0010 — `geography(Point, 4326)` as the spatial source of truth

**Status:** Accepted (PR-02, 2026-09-04)

## Context

Places are the first geographic domain, and every query that matters is spatial:
"what is near me", "what is in this viewport". The storage decision determines
whether those queries are correct and whether they can use an index — both are
expensive to change once data exists.

PostGIS offers two spatial types, and the distinction is not cosmetic:

- `geometry` treats coordinates as points on a plane. `ST_Distance` returns
  **degrees**, which is not a distance: one degree of longitude is 111 km at the
  equator and 0 km at the pole. A radius search written against it is wrong by a
  latitude-dependent factor.
- `geography` computes on the spheroid. `ST_Distance` returns **metres** and
  `ST_DWithin` takes metres.

## Decision

**`geography(Point, 4326)`**, with a GIST index on it.

Verified against real coordinates: Marco Zero (Recife) → Igreja da Sé (Olinda)
measures 6,242 m, which matches the ground truth. The same pair under `geometry`
returns ≈0.056 — a number with no physical meaning.

**The API speaks degrees.** `latitude`/`longitude` in WGS84, in and out. Web Mercator
is Mapbox's internal projection and never appears in the domain or on the wire (§20).

**Distances are metres, everywhere in the backend** (§21). Choosing when to render
"1.2 km" is a presentation decision and lives in the client.

**Drizzle models the column through `customType`**, not through its built-in
`geometry` helper — which emits the wrong type. Spatial predicates are written as
explicit SQL, per ADR-0004: `ST_DWithin`, `ST_MakeEnvelope` and the casts are the
interesting part of these statements, and hiding them in a query builder would make
index usage harder to see and to review.

### The viewport query is where this gets subtle

`&&` is a bounding-box overlap and is what the GIST index answers directly. But the
operands must be the same type, and getting that wrong disables the index *silently*.
Measured at 40,000 rows:

| Predicate | Plan | Time |
| --- | --- | --- |
| `location::geometry && envelope` | Seq Scan | 23.5 ms |
| **`location && envelope::geography`** | **Bitmap Index Scan** | **0.8 ms** |
| `ST_Intersects(location, envelope::geography)` | Index Scan | 27.5 ms |

Casting the *column* is the form that reads most naturally and it is thirty times
slower. Casting the *envelope* keeps both sides `geography` so the index applies. An
integration test asserts the index is reachable for the correct form and unreachable
for the incorrect one, so this cannot silently regress.

`&&` is an overlap rather than an exact containment test, so a few markers just
outside the viewport can be returned. For deciding what to draw that is harmless —
arguably better, since an edge marker stays visible while panning.

## Alternatives

- **Two `double precision` columns for lat/lng.** Rejected: no spatial index, so
  every proximity query is a full scan; no polygon or viewport support; and distance
  would have to be hand-computed, which §77 forbids while PostGIS is available.
- **`geometry(Point, 4326)` with casts at query time.** Rejected: every distance and
  radius would need `::geography` at the call site, and forgetting one produces a
  wrong answer rather than an error — precisely the class of bug that does not
  announce itself.
- **`geometry` in a projected SRID (e.g. 31985, UTM 25S).** Rejected: metres come for
  free within the zone, but Trilha is not zone-bounded, and re-projecting at zone
  edges is a permanent tax for a benefit `geography` already provides.
- **Geohash strings.** Rejected: an indexing trick, not a spatial type; prefix
  matching approximates a box poorly and cannot express distance at all.

## Consequences

- Radius and viewport queries are correct at any latitude, in metres, and both use
  the spatial index.
- Reads of the column go through `ST_X`/`ST_Y` in explicit SQL. That is deliberate:
  the coordinates leave the database already in the API's units.
- **PostGIS coerces rather than rejects an out-of-range coordinate**: inserting
  latitude 91 stores 89, with only a NOTICE. The database therefore cannot be the
  guard for §8, and application-side validation is the enforcement point — see
  `domain/coordinates.ts`, and the test that asserts an invalid coordinate never
  reaches storage.
- Baseline at 40,007 rows: viewport 3.7–4.2 ms, radius 45–69 ms, search 12–17 ms.
