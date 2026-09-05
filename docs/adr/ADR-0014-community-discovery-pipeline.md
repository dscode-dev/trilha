# ADR-0014 — The discovery pipeline, and where money is allowed to be spent

**Status:** Accepted (PR-04, 2026-09-05)

## Context

Trilha can now compute a route and knows thousands of Places. The product question
that follows is the one the whole platform exists to answer:

> Given a route from A to B, which Places are actually worth stopping at on the way?

The naive answer — "the ones near the line" — is wrong in a way that matters. A Place
2 km from the route across a river with no bridge is 25 minutes of driving. A Place
4 km away on the same highway is 7 minutes. Straight-line proximity does not know the
difference, and a feature built on it recommends the wrong places confidently.

Knowing the difference means asking a routing provider what a diversion actually
costs, and that changes the engineering problem. Proximity is free — it is a spatial
index lookup. Detour is billed per request. So the design constraint is not "make it
accurate", it is:

> Make it accurate **and** make the upstream cost of one discovery request a number
> someone can state in advance.

The failure mode to avoid is specific: a corridor containing 400 Places, each turned
into a provider call. That is not slow, it is unboundedly expensive, and it gets more
expensive precisely where the product is most useful — a dense city.

## Decision

**A funnel, ordered so that everything free happens before anything billed.**

```
Route              1 provider call (Directions), computed by Trilha
  ↓
Spatial retrieval  PostGIS, GIST-indexed, capped at 100
  ↓
Cheap filters      status, category, endpoint coincidence, route position
  ↓
Detour evaluation  1 provider call (Matrix), capped at 20 candidates
  ↓
Relevance score    pure function, no I/O
  ↓
Ranking            deterministic sort, cut to the page size
```

Inverting any two of these steps turns a fixed cost into one that scales with how many
Places happen to sit near the route. The order *is* the design.

### The backend computes the route; the client never supplies a geometry

The alternative — client sends the geometry it already has, backend skips a call — is
cheaper by one Directions request and unacceptable. A geometry from a client is an
**attacker-chosen search area over a metered pipeline**: a LineString tracing the
Brazilian coastline is a valid GeoJSON document, and it would drive both a spatial
query and a batch of billed matrix calls. There is no amount of validation that makes
attacker-supplied input as safe as input Trilha derived itself, and the request that
would have to be validated is the *expensive* one.

So `POST /discovery/routes` takes an origin and a destination — the same two points
`/routes/calculate` takes — and calls the Routing Core internally. The client payload
is two coordinate pairs, which is also better for a phone on a Brazilian mobile
connection than posting a full-overview LineString.

### `ST_DWithin` against the line, not a buffered corridor

Both forms return the same Places and both reach `places_location_gist_idx`. Measured
warm at 40,007 rows, on a 105 km route at 5 km either side, both returning 413:

| Form | Time |
| --- | --- |
| **`ST_DWithin(location, line::geography, 5000)`** | **24–48 ms** |
| `ST_Buffer(...)` then `&&` + `ST_Intersects` | 51–75 ms |

The buffer is a polygon PostGIS must build, densify and then test against, to answer a
question `ST_DWithin` answers from the line directly. The *corridor* remains the
concept — "within this distance of the route" — but materialising it as geometry is
only worth doing when something needs the polygon itself, and discovery does not. An
integration test asserts the two forms return identical Places, so the cheaper one is
not quietly a different question.

`routeProgress` is geodesic: `ST_LineLocatePoint` gives a fraction of *planar* length
in degrees, which is not the fraction of the journey, so the substring is measured on
`geography` and divided by the geodesic total. At 40k rows it costs nothing detectable
(17 ms either way).

### A separate `RouteCostProvider` port

Not a method bolted onto `RoutingProvider`. The two answer different questions —
one produces *a route* a person will follow, the other produces *a number* — and a
provider may well serve them from different APIs with different limits, which is
exactly what happens here.

The Mapbox adapter uses the **Matrix API**, verified against current documentation at
implementation time: 25 coordinates per driving request, 60 requests per minute,
duration and distance annotations together without reducing the coordinate limit.
Origin and destination take two slots, leaving **23 via-points per call**. The
Optimization API is deliberately unused — it solves a travelling-salesman ordering,
and discovery orders nothing (§19). So is `driving-traffic`: live traffic would make
the same request rank differently minute to minute, and V1 promises determinism.

### The worst case, stated

| Stage | Calls |
| --- | --- |
| Route calculation | 1 |
| Detour evaluation (20 candidates ÷ 23 per call) | 1 |
| **Total per discovery request** | **2** |

Bounded by four independent ceilings — spatial candidates (100), detour candidates
(20), provider concurrency (4), and a rate limit of 20 requests per user per hour —
and none of them depends on how many Places exist.

### Failure is graded

A `null` matrix entry means the provider cannot reach that Place by road. That is a
fact about the place, so the candidate is dropped and the rest stand. A dead provider,
or an origin and destination the matrix cannot connect at all, fails the request:
returning an empty list would report an outage as "nothing found", which is the one
answer a user has no way to question.

## Alternatives

- **One Directions call per candidate.** Rejected: twenty candidates is twenty billed
  requests and twenty round trips, and the cost scales with Place density.
- **Skip detour; rank by distance from the route.** Rejected: it is the premise of the
  feature that these differ, and it is the difference the user feels.
- **Cache discovery results.** Rejected for now (§43). A correct key would have to
  cover the route, corridor width, detour ceiling, category set, policy version *and*
  the Place dataset version; the last is what makes it hard, since a new Place must
  invalidate every corridor containing it. At 45 ms of PostGIS and one matrix call,
  there is nothing yet worth that complexity — and a cache keyed on a route is a
  record of where people are going, which §53 refuses.
- **Persist `RouteCandidate`.** Rejected: derived from a route, a Place and a policy,
  all of which already exist. Storing it would mean storing routes (ADR-0012) and
  would freeze a ranking that is explicitly versioned to change.

## Consequences

- Discovery owns no tables and PR-04 adds no migration.
- `PlacesModule` exports exactly one read capability, `PlacesAlongRouteQuery`, rather
  than its repository — Discovery can ask a spatial question about Places and cannot
  write one (ADR-0001).
- Every ceiling is configuration; none of the *scoring weights* are (ADR-0015).
- Baseline at 40,000 Places: spatial retrieval 45 ms, 100 candidates, ranking 2 ms.
