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

---

## Amending this document

1. Open an ADR in `docs/adr/` naming the clause and the reason.
2. State what compliance costs and what the exception costs.
3. On acceptance, edit the clause here and link the ADR.

A clause that is silently ignored is worse than one that was never written.
