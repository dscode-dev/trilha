# The Trilha Constitution

The rules below govern how Trilha is built. They are binding on every pull request.

A principle here is not a style preference: it encodes a decision that is expensive to
reverse later. Breaking one requires an ADR in `docs/adr/` that states the cost of
compliance, the cost of the exception, and why the exception wins.

Established in PR-00. Amended only by an ADR that supersedes the relevant clause.

---

## Architecture

**1. Modular monolith first.**
Trilha V1 is one deployable NestJS application with internal module boundaries.
Boundaries are enforced by module structure and review, not by network hops.

**2. A microservice requires proven need.**
Extraction demands evidence — a measured scaling limit, an isolation requirement, or an
independent release cadence that the monolith genuinely blocks. "It feels cleaner" is
not evidence. Distribution buys independence and pays for it in latency, partial
failure and debugging cost.

**3. The domain depends on nothing.**
Domain logic does not import Flutter, NestJS, an ORM, Mapbox, or an LLM SDK. Each of
those will be replaced or repriced during Trilha's life; the domain must outlive them.

**4. PostGIS is central geospatial infrastructure, not a detail.**
Trilha is a geospatial product. Spatial indexes, `ST_*` functions and query plans stay
directly reachable. No abstraction may make `EXPLAIN ANALYZE` unavailable.

**5. Redis is never a source of truth.**
It is a cache and a coordination primitive. Every value in Redis must be reconstructible
from PostgreSQL. Losing Redis degrades Trilha; it never corrupts it.

**6. PostgreSQL is the transactional source of truth.**
Anything that must survive, be audited, or be reconciled lives in PostgreSQL.

**7. The mobile app is feature-first.**
Code is organised by capability (`features/trails/`), not by technical layer
(`models/`, `services/`). Layers exist *within* a feature.

**8. Business rules never live in a widget.**
A widget renders state and reports intent. Rules that survive a UI redesign belong in
`domain`/`application` and must be testable without pumping a widget.

---

## Domain future-proofing

These clauses exist because the alternatives are cheap now and very expensive later.

**9. `Place` and `Trail` are different concepts.**
A Place is a location that exists in the world. A Trail is a curated route through
places. Collapsing them destroys the ability to reuse a Place across many Trails.

**10. A `TrailStop` references a resolved Place.**
A stop points at a Place entity, never at a loose name or coordinate pair. Unresolved
input is resolved into a Place first, or explicitly held as unresolved — never silently
duplicated.

**11. Quality rating and Safety are different domains.**
"Was this enjoyable?" and "is this dangerous?" have different sources, lifecycles,
review requirements and consequences. They never share a model or a score.

**12. Community opinion is not a factual assertion.**
"Users find this beautiful" and "this road is closed" are different claims with
different evidentiary weight. The schema must keep them distinguishable.

**13. Safety data requires provenance, recency and lifecycle.**
Every safety-relevant record carries where it came from, when it was established, and
when it expires. Safety information without a timestamp is not safety information.

**14. AI never determines Safety.**
A model may summarise or surface existing safety data. It may never originate a safety
assertion. A hallucinated "this route is safe" is a physical-harm risk.

**15. AI never writes directly to the domain.**
Model output enters as a *suggestion* in its own store, and becomes domain data only
through an explicit, attributable promotion path.

**16. An AI suggestion is not automatically a Place.**
Promotion requires resolution and validation.

**17. An AI suggestion is not automatically a TrailStop.**
Same reasoning, separately stated because the shortcut is tempting in both directions.

**18. Equivalent trails converge on a canonical representation.**
Two users describing the same real-world route must eventually reconcile to one
canonical Trail. The schema must not make that impossible.

**19. Truth is not duplicated to simplify a UI.**
If a screen needs a different shape, build a read model or a projection. Do not create a
second writable copy of a fact — two writable copies of one fact diverge.

---

## Identity and session

Established in PR-01. These are invariants, not implementation details: each exists
because violating it converts a recoverable incident into an account takeover.

**31. A refresh token is never persisted in a readable form.**
Only a digest is stored, server-side and client-side alike. A database dump or a device
backup must not yield usable tokens.

**32. Refresh rotation is single-use.**
Refreshing consumes the presented token and issues a successor. Concurrency is settled
by the database, never by an application lock — a guarantee that survives a second
instance is the only kind worth having.

**33. Reuse of a rotated refresh token revokes the whole session.**
A replayed token means theft or a lost race, and the two are indistinguishable. Both
are treated as compromise. Signing out a legitimate user is the accepted cost; leaving
a thief with a live session is not.

**34. Access tokens are short-lived and carry no profile.**
Minimum claims only — subject, session, issuer, audience, validity. A bearer token
travels through logs and proxies, and embedded profile data goes stale the moment it
changes.

**35. Credential, identity and public profile are separate.**
Reading a profile must never touch password material, and rotating a secret must never
rewrite identity.

**36. Case-insensitive identity is enforced by the database.**
Email and username uniqueness rests on generated columns and unique indexes, not on
remembering to normalise at every call site.

**37. Authentication endpoints do not disclose whether an account exists.**
Login returns one answer, in comparable time, for an unknown address and a wrong
password. Registration is the sole documented exception, because a signup form cannot
function otherwise.

**38. On the client, a refresh token lives only in platform secure storage.**
Keychain or Keystore-backed. Never `SharedPreferences`, a file, or a plain database.
The access token stays in memory.

**39. Client refresh is single-flight.**
Concurrent callers share one rotation. Firing several is not merely wasteful — with
single-use tokens it is indistinguishable from a replay attack against our own server.

**40. Changing a password revokes every session, the caller's included.**
Someone changing a password may be reacting to a compromise, and there is no way to
tell which live session belongs to the attacker.

---

## Geography

Established in PR-02.

**42. PostGIS is the spatial source of truth.**
A location lives in a `geography(Point, 4326)` column. No pair of `double` columns
shadows it, and no derived copy is authoritative.

**43. The API speaks WGS84 degrees.**
`latitude` and `longitude`, in and out. Web Mercator is a rendering projection and
never appears in the domain or on the wire.

**44. Distance is metres, computed by PostGIS.**
Metres are the canonical unit everywhere in the backend. Formatting — "850 m",
"1.2 km" — is a presentation decision. Hand-rolled Haversine is not an acceptable
substitute for a spatial query.

**45. Coordinates are validated before they reach SQL.**
PostGIS *coerces* an out-of-range coordinate rather than rejecting it: latitude 91
is stored as 89, with only a notice. The application is therefore the enforcement
point, not a convenience layer in front of one.

**46. Map reads are bounded.**
Every spatial query has a ceiling — a maximum radius, a maximum viewport, a maximum
result count. An unbounded geographic query is a table scan wearing a viewport.

**47. A Place carries no rating, safety score or trail count.**
Those belong to domains that own them. A nullable column reserved for a future
domain is an invitation to fill it with something fabricated.

**48. A community Place belongs to the platform, not to its contributor.**
`createdBy` is attribution, not ownership. It must never become a permission that
blocks correction.

**49. The map renderer is not a source of Places.**
Mapbox draws what Trilha knows. A third-party POI has no provenance, no contributor
and no lifecycle, and must not enter the domain as though it did.

**50. Personal location is device-local and ephemeral.**
A user's position centres their map and is then discarded. It is never persisted,
never sent to Trilha's servers, and background location is never requested.

---

## Routing

Established in PR-03.

**51. A `Route` is not a `Trail`.**
A Route is what the road network says about getting from A to B: geometry, distance,
duration, nothing else. It has no name, no author, no stops and no opinion. A Trail is
a curated experience built over routes and places. Clause 9 is the same argument one
level up, and collapsing these two is the same mistake.

**52. Routing is bought through a port, never called directly.**
Every consumer depends on the `RoutingProvider` interface. Only the adapter knows
which provider is behind it, what its URL looks like or how it encodes a geometry. A
provider's response shape is never the public contract.

**53. Provider failure is normalised before it leaves the module.**
Upstream status codes, vendor error strings and transport exceptions stop at the
adapter. Callers receive Trilha's vocabulary, and the mapping distinguishes *our*
problem from the caller's: an expired platform credential is `PROVIDER_UNAVAILABLE`,
never a 401 the user could act on.

**54. The routing credential is not the map credential.**
The mobile SDK's public token ships inside the app by design. The routing token buys
billable calls and is server-side only. One is world-readable; the other is a secret.
They are never the same value.

**55. A routing call is authenticated and rate-limited.**
Routing spends money at a third party on request. An open routing endpoint is a free
public proxy to a metered API. Ceilings are per user *and* per IP.

**56. A corridor is buffered in metres, on `geography`.**
`ST_Buffer` on a 4326 geometry reads its argument as degrees and returns a quarter of
the planet without warning. Any distance the product asserts — buffer, containment,
length — is computed on `geography`. Approximate conversions are permitted only for
choosing how much detail to discard, never for a number a user sees.

**57. Routes are not persisted.**
A route is a derived answer that expires with the road network. Recording every
calculation would build a record of where people intend to go, which nobody asked
for and clause 50 refuses in the equivalent case. A route is stored only when a user
deliberately saves it as part of a named artefact.

**58. Route endpoints are not logged.**
Distance, duration and vertex count are operational data. An origin and a destination
are a statement about a person's movements. Metric labels derived from coordinates are
the same disclosure with extra steps, and are equally forbidden.

---

## Discovery

Established in PR-04.

**59. Relevance is a property of a pairing, not of a Place.**
"How well does this place fit this route?" is the only relevance question Trilha can
answer. A `places.relevance_score` column would have to mean "relevant in general",
which is not a claim the platform can make or defend. Relevance is
`score(place, route, policy)` and is computed, never stored.

**60. The cheap stage always precedes the billed one.**
Spatial filtering, status and category checks and endpoint coincidence all happen in
PostGIS before a single provider call. Evaluating detours first would turn a fixed
cost into one that scales with how many Places happen to sit near a route — worst
exactly where the product is most useful.

**61. Provider cost per request is bounded and stated.**
Every discovery has an upper bound on upstream calls that does not depend on how many
Places exist. If that number cannot be stated, the pipeline is not finished.

**62. A search area is never supplied by the caller.**
Trilha computes the route it searches along. A client-supplied geometry is an
attacker-chosen search area over a metered pipeline, and no amount of validation makes
it equivalent to one the platform derived itself.

**63. Ranking is deterministic, explainable and versioned.**
The same inputs produce the same order, every tie is broken by a stable rule, every
candidate carries reason codes, and every response names the policy that produced it.
Scores from different policy versions are not comparable and the contract says so.

**64. A ranking may only use signals that exist.**
No invented popularity, no proxy for quality, no bonus for provenance or for how much
description someone typed. When a domain that owns a signal does not exist yet, the
signal does not exist yet.

**65. A score is not shown to a user.**
"+7 min" is a fact someone can act on. `0.91423` is an implementation detail that reads
as a quality rating and invites comparisons that are not valid.

**66. Travel intent is not persisted.**
Origin, destination, geometry, corridor, candidates and what the user picked are all
discarded when the request ends. Recording them would build a record of where people
intend to go, which clause 57 already refuses for routes and clause 50 for positions.

**67. An empty result is an answer.**
"Nothing along this route within the detour you accept" is a successful response and
must not be dressed as a failure. Equally, an upstream outage must not be dressed as
an empty result.

---

## Engineering

**20. UTC internally.**
All stored and transmitted instants are UTC. Local time is a presentation concern,
applied at the edge.

**21. Identifiers are not publicly enumerable.**
Public-facing ids are UUID/ULID-style. Sequential integers leak volume and enable
scraping.

**22. Migrations are mandatory.**
Every schema change ships as a reviewed, version-controlled migration that runs from an
empty database.

**23. No automatic schema mutation in production.**
ORM `synchronize`/auto-migrate is prohibited outside a developer's own machine.

**24. No deprecated dependencies.**
A dependency that is unmaintained or deprecated is replaced, not carried. A deprecation
warning is a scheduled task, not background noise.

**25. Latest stable by default.**
Versions are verified against upstream at implementation time, never assumed from
memory or copied from a tutorial. `latest != latest production-ready`; we take
`latest stable`. Current selections: `docs/technology-baseline.md`.

**26. No beta, RC, alpha, canary or nightly without an ADR.**
An unstable version requires a documented, concrete justification and no viable stable
alternative.

**27. No feature ships without tests proportional to its risk.**
Proportional, not uniform: a geospatial query, a money path and a safety rule earn more
scrutiny than a label change. Where the point is integration, the test must integrate —
mocking the dependency under proof proves nothing.

**28. Observability does not depend on `console.log` or `print`.**
Structured, levelled, contextual logging only. Every request carries a correlation id.

**29. No mock or demo path reaches production.**
No fake users, seeded product data, hardcoded handler responses, or placeholder screens
presented as implementation. If it is not real, it does not ship.

**30. Security and privacy are architectural requirements.**
Validated configuration, secrets out of Git, least privilege, non-root containers,
explicit CORS, and logs that never contain credentials or personal data. These are
design inputs, not a hardening pass scheduled for later.

**41. Personal data is minimised and never stored where a digest will do.**
Collect only what a feature genuinely needs. Client addresses in audit records are
keyed digests, not addresses; identifiers in cache keys are hashed. Nothing is
retained because it might be useful later.

---

## Amending this document

1. Open an ADR in `docs/adr/` naming the clause and the reason.
2. State what compliance costs and what the exception costs.
3. On acceptance, edit the clause here and link the ADR.

A clause that is silently ignored is worse than one that was never written.
