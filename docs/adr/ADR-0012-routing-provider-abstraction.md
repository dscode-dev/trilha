# ADR-0012 — Routing behind a port, with Mapbox as one adapter

**Status:** Accepted (PR-03, 2026-09-04)

## Context

Turning an origin and a destination into a drivable path requires a road graph.
Trilha does not have one and will not build one: OpenStreetMap-derived routing is a
product in itself, and the platform's value is what it builds *on top of* a route,
not the route.

So routing is bought. That makes the provider a dependency with three properties the
rest of the system must be insulated from:

1. **It costs money per request.** Every call is billable, which changes who may make
   one and how often.
2. **It fails in ways nothing else in Trilha does.** Upstream timeouts, upstream rate
   limits, upstream outages, and "these two points are not connected by road" are all
   normal outcomes, not exceptions.
3. **It is replaceable, and probably will be replaced.** Pricing changes; coverage in
   Brazil varies by provider; self-hosting OSRM or Valhalla becomes attractive at
   volume. PR-04 and beyond will consume routes heavily.

The naive shape — a service that calls Mapbox and returns Mapbox's JSON — makes all
three properties leak. The vendor's response shape becomes the domain, its error
codes become the API's error codes, and a migration means touching every consumer.

## Decision

**A `RoutingProvider` port in the domain, and a `MapboxRoutingProvider` adapter in
infrastructure.** Nothing outside `modules/routing/infrastructure/` knows Mapbox
exists.

```ts
export interface RoutingProvider {
  calculateRoute(request: RoutingRequest): Promise<RoutingResult>;
}
export const ROUTING_PROVIDER = Symbol('RoutingProvider');
```

The port speaks Trilha's vocabulary: `RoutePoint`, `RoutingProfile.DRIVING`, and a
result carrying a GeoJSON `LineString`, metres, seconds and legs. GeoJSON is not a
Mapbox concept — it is the interchange format the database and the client already
speak — so the contract stays neutral while avoiding a pointless re-encoding.

**Provider failures are normalised at the boundary.** The adapter maps upstream
outcomes onto four codes, and the mapping encodes a judgement about *whose* problem
each one is:

| Upstream | Trilha | Why |
| --- | --- | --- |
| 429 | `PROVIDER_RATE_LIMITED` | Our quota, not the caller's — distinct from `TOO_MANY_REQUESTS` |
| 401, 403 | `PROVIDER_UNAVAILABLE` | Our credential is wrong; the caller did nothing wrong and must not see 401 |
| 422 | `ROUTE_NOT_FOUND` | A real answer: no road connects these points |
| 5xx | `PROVIDER_UNAVAILABLE` | Transient upstream |
| `TimeoutError` | `PROVIDER_TIMEOUT` | Distinguished from unavailable so latency is diagnosable |

Mapping 401 to `PROVIDER_UNAVAILABLE` rather than passing it through is the
load-bearing one. An authenticated caller who receives 401 will re-authenticate, and
re-authenticating cannot fix our expired Mapbox key.

**A separate credential: `MAPBOX_ROUTING_ACCESS_TOKEN`.** The mobile SDK's public
token ships inside the app and is world-readable by design; the routing token is
server-side and buys billable Directions calls. Reusing one for both would put a
spendable credential in an APK. They are different secrets with different threat
models, and the config schema treats them as such — production refuses to start on a
placeholder value.

**The endpoint is authenticated and separately rate-limited.**
`POST /api/v1/routes/calculate` sits behind `AuthGuard` plus a routing-specific guard
with its own per-user and per-IP ceilings. An anonymous routing endpoint is a free
public proxy to a metered API, discoverable by anyone who opens the OpenAPI document.

**Native `fetch` with `AbortSignal.timeout`, no HTTP client dependency.** Node 24
provides both. An unbounded upstream call holds a request, a database connection and
a client socket for as long as the provider takes.

## Alternatives

- **Call Mapbox directly from the mobile app.** Rejected: the token would ship in the
  binary and be extractable in minutes; there would be no rate limiting, no corridor,
  and no way to change providers without an app-store release.
- **Return the provider's payload and let clients interpret it.** Rejected: it makes
  the vendor the public contract. An integration test asserts the generated OpenAPI
  document contains neither `mapbox` nor `access_token`, so this cannot drift back in.
- **A generic HTTP "routing service" with the URL in configuration.** Rejected: it
  looks provider-independent but is not — auth style, parameter names, response shape
  and error semantics all differ per provider. The seam belongs at the type level.
- **Self-host OSRM or Valhalla now.** Rejected for PR-03, not forever: it is an
  operational commitment (graph builds, OSM extract updates, dedicated hosting) that
  buys nothing until routing volume is real. The port is precisely what makes that a
  later, contained decision.

## Consequences

- Swapping providers means one new class and one binding. `FakeRoutingProvider` in
  the test suite already proves the seam is real rather than aspirational.
- Every routing test runs offline. The provider adapter is tested against stubbed
  `fetch` with sanitised fixtures; the API integration tests override
  `ROUTING_PROVIDER`. No test needs a credential or a network.
- Provider latency and internal latency are logged as separate fields, so "routing is
  slow" can be attributed without a trace.
- **The provider URL is never logged.** It carries the access token in a query
  parameter, so logging the request URL on failure — the reflex — would write a
  spendable credential to the log store.
- Routes are **not persisted**, and PR-03 adds no migration. A route is a derived
  answer that expires with the road network; storing every calculation would create a
  movement-history database nobody asked for (§58). Persistence arrives with Trails,
  where a route is deliberately saved as part of a named artefact.
