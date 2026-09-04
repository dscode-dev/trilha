# ADR-0013 — Route geometry on the wire, and the corridor in metres

**Status:** Accepted (PR-03, 2026-09-04)

## Context

A calculated route has to travel three places, and each imposes different demands:

- **To the client**, to be drawn as a line and framed by the camera.
- **Into PostGIS**, to answer "what is near this route" — the question PR-04's
  discovery is built on.
- **Nowhere else.** It is not stored.

Two decisions had to be made once and made correctly, because both fail *silently*
when made wrong: the encoding of the geometry, and the unit of the corridor width.

## Decision

### Geometry is GeoJSON `LineString`, in WGS84 degrees, longitude-first

Not an encoded polyline. The polyline format is a compression scheme Mapbox happens
to prefer; GeoJSON is what PostGIS reads with `ST_GeomFromGeoJSON`, what Mapbox's own
client SDKs accept, and what is legible in a log or a test fixture. `overview=full`
plus `geometries=geojson` gives a route we can pass straight to the database.

**Longitude-first is the GeoJSON specification, and it is the opposite of every
human-facing convention in the product** — the API speaks `{latitude, longitude}`,
Dart's `LatLng` is latitude-first, and PostGIS's `ST_Y` is the latitude. Reversing
the pair produces no error anywhere in the stack; it draws the route into the Indian
Ocean. Both the client's decoder and the overlay have a test asserting the order
explicitly, because nothing else in the system will catch it.

### Bounds are computed by Trilha, from the vertices

Not taken from the provider, even though Mapbox returns them. Bounds are what the
camera frames, so a route whose bounds disagree with its geometry shows a line
running off-screen. Computing them from the same array that gets drawn makes that
disagreement impossible by construction, and costs one pass.

### The corridor is `ST_Buffer` on `geography`, never on `geometry`

This is the decision the whole feature turns on.

```sql
-- WRONG. 5000 is read as 5000 DEGREES.
ST_Buffer(line_4326, 5000)

-- RIGHT. 5000 is read as 5000 metres.
ST_Buffer(line_4326::geography, 5000)::geometry
```

`ST_Buffer` on a 4326 *geometry* interprets its distance in the units of the SRID,
which for 4326 is degrees. It does not warn. Measured on the Recife → João Pessoa
fixture (~105 km of road, 5 km requested either side):

| Form | Resulting area |
| --- | --- |
| `ST_Buffer(geometry, 5000)` | **221,122,129 km²** — roughly a quarter of the Earth |
| `ST_Buffer(geometry::geography, 5000)` | **1,128 km²** — as expected |

The wrong form is not merely inaccurate; it returns a polygon that contains almost
every Place in Brazil, so a "nearby the route" feature built on it would look like it
worked and be meaningless. An integration test asserts the area falls between 900 and
1,400 km², which fails by four orders of magnitude if the cast is ever dropped.

The same reasoning applies to containment: `ST_DWithin` on `geography` takes metres,
and that is the form `isWithinCorridor` uses.

### The line is simplified before it is buffered

`ST_SimplifyPreserveTopology` at a 25 m tolerance, applied first. A full-overview
intercity route returns on the order of two thousand vertices, and buffering each one
produces a polygon too large to transmit and slow to compute. Simplifying first keeps
the corridor to tens of vertices — the measured serialisation stays under 60 KB, and
a 2,000-vertex input completes well inside the performance budget. A 25 m tolerance is
invisible against a 5,000 m corridor.

`ST_SimplifyPreserveTopology` operates on geometry, so the tolerance is converted from
metres by dividing by 111,320 — the metres per degree of latitude. That approximation
is wrong for longitude away from the equator, and it is acceptable *only* because it
governs how much detail to discard, never a distance the product asserts. Every
number the product states comes from `geography`.

### Validation is Trilha's job, not PostGIS's

`parseLineString` lives in `domain/route.ts` and runs on every corridor operation. It
was originally in the Mapbox adapter, on the assumption that PostGIS would reject
degenerate input. It does not: **PostGIS happily accepts a one-position LineString and
buffers it into a polygon.** A two-position minimum is a Trilha invariant about what
a route is, not a vendor detail, so it belongs in the domain and is enforced at the
repository boundary — which PR-04 will call directly.

### The corridor is opt-in and bounded

`includeCorridor` defaults to false, and the mobile client sends false explicitly: the
app draws the line, never the corridor, and shipping a large polygon to a phone on a
Brazilian mobile connection buys nothing. Width is bounded by
`ROUTING_CORRIDOR_MAX_METERS`, and a structural invariant check refuses to start —
in any environment — if the configured default exceeds the configured maximum.

## Alternatives

- **Encoded polyline on the wire.** Rejected: smaller, but opaque in logs and
  fixtures, and it needs a decoder on both sides before PostGIS can read it.
- **Provider-supplied bounds.** Rejected: see above; a second source of truth for the
  same fact.
- **A projected SRID (UTM 25S) for buffering.** Rejected for the reason ADR-0010 gives
  for storage: metres come free within a zone, and Trilha is not zone-bounded.
- **Buffering the unsimplified line.** Rejected on measurement: quadratically more
  vertices for detail no corridor query can use.
- **Storing corridors.** Rejected: a corridor is a pure function of a geometry and a
  width, cheap to recompute, and storing it would mean storing routes (ADR-0012).

## Consequences

- "Places near this route" is answerable in PR-04 with an index-backed
  `ST_DWithin`, in metres, at any latitude.
- The corridor is computed in the database rather than in TypeScript. Reimplementing
  a geodesic buffer in application code is the kind of thing that looks tractable and
  is not.
- Routing owns no tables, so the module exports `CorridorRepository` and adds no
  migration. Data ownership (ADR-0001) is unviolated: it reads no other module's
  tables either.
