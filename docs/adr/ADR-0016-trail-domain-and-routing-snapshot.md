# ADR-0016 — A Trail is composition, not calculation

**Status:** Accepted (PR-05, 2026-09-05)

## Context

Trilha can compute a route and rank places along it. Neither of those is a thing a
user owns. This PR introduces the first one that is: a Trail — which places, in which
order, deliberately saved.

The temptation is to model a Trail as a route with extra fields. It is not. A route is
what the road network says today; it is derived, disposable, and belongs to nobody. A
Trail is a decision someone made, and it has to survive the road network changing
underneath it. Conflating them produces a specific, bad outcome: **a saved trail whose
distance quietly changes because a road closed overnight.**

Two questions follow. What does a Trail own, and what does it merely remember?

## Decision

### The split

| Owns | Remembers |
| --- | --- |
| Endpoints, stops, their order, status, revision | Geometry, distance, duration, provider, when it was calculated |

Routing owns the second column; a Trail keeps a **snapshot** of it. Opening a trail
tomorrow shows the same line and the same numbers as today, because it reads the
snapshot rather than re-asking. The one way the numbers change is an explicit
"Atualizar rota" (§70), which is a user action, not a side effect of opening a screen.

The snapshot is **provider-independent** by construction — GeoJSON, metres, seconds,
and a bare provider name. A raw Directions payload would make every saved Trail
unreadable the day the supplier changes, which is the whole thing ADR-0012 set out to
avoid. The provider name is stored for support and **not published in the API**: a
client has no use for it, and putting a supplier's name in the contract — even as an
example value — is how a contract stops being provider-independent.

### A stop is always a resolved Place

Never a coordinate, never free text (constitution §Domain, §10). An unresolved stop
cannot be shown, searched, deduplicated or reused across trails, and admitting one
would make every consumer handle a case that should not exist. Where the user taps
somewhere with no Place, the answer is the PR-02 contribution flow — create the Place,
then add the stop — not a weaker `TrailStop`.

The foreign key is `ON DELETE RESTRICT`, unlike `places.created_by_user_id`'s
`SET NULL`. A refused delete beats a mutilated Trail: silently dropping a stop because
its Place row went away would rewrite someone's composition without asking. Places are
archived rather than deleted, so this should never fire — and an archived Place stays
on a Trail that already has it while being refused as a *new* stop (§51).

### Order is explicit, and integers are enough

`position`, 1-based and contiguous, never derived from `created_at`: a reorder changes
the order without creating anything, so insertion time stops describing the sequence
the moment the user drags a row.

Plain integers rather than fractional indexing. A Trail holds at most fifteen stops;
rewriting fifteen integers is cheaper than the machinery that avoids it, and the
machinery would have to be understood by everyone who touches the table.

Contiguity is enforced by a **deferred** constraint trigger. A reorder necessarily
passes through states where two rows share a position, so an immediate check would
reject the legitimate write; deferring to COMMIT asserts the invariant on the state
that actually gets persisted. The intermediate parking positions are *above* the
occupied range rather than negative — `position >= 1` is a row-level CHECK, and
negatives were the obvious choice and the one thing the schema forbids.

### Fifteen stops

The binding constraint is the provider: Mapbox Directions accepts **25 coordinates**
per driving request (verified against current documentation at implementation time),
and origin and destination take two, leaving 23. Fifteen sits deliberately below that
— margin for a provider that publishes a smaller limit, and a UX bound besides, since
a list of twenty-three stops is no longer something a person reorders by dragging.

### Two snapshots, not one

`route` is the composed journey; `baseRoute` is A → B with no stops. The second exists
so the app can say what the whole detour costs (§38), and it is a function of the
**endpoints alone**. So it is recomputed when the endpoints move, or when the user asks
for a refresh, and reused when only stops changed — recomputing it there would be a
billed call that cannot change the answer.

`detour` is `null`, not zero, when either snapshot is missing. "Not measured" and "no
detour" are different claims, and rendering the first as the second states a fact
Trilha does not have.

### Waypoints extend the existing port

`RoutingRequest` gains `waypoints`, visited **in the order given**. Routing still knows
nothing about Trails — it receives ordered points, and that they came from a
`TrailStop` is not a fact that layer needs. A `TrailRoutingProvider` would have been a
second name for the same capability.

No optimiser. Reordering the user's stops to save four minutes would silently discard
the decision they made, which is the one thing a composition tool must not do.

### Lifecycle: three states, none of them social

`DRAFT`, `FINALIZED`, `ARCHIVED`. `FINALIZED` means "I finished composing this" and
**not** "I published it" — nobody else can see a Trail in PR-05. Editing a finalized
Trail returns it to `DRAFT`, which keeps "finished" an honest description of the
current state rather than a one-way door, and avoids immutable versioning that nothing
needs yet.

There is no `is_public`, no slug, no share count, no comment count. Publication is a
later PR with rules of its own; a column reserved for it now is an invitation to fill
it with something that has none.

## Alternatives

- **A Trail as a Route with stops.** Rejected: the saved numbers would drift with the
  road network, and "my trail is 145 km" would stop being true without anyone editing
  anything.
- **Recompute the route on every read.** Rejected: it makes opening a trail cost a
  billed call, makes it fail when the provider is down, and makes what the user saved
  unstable.
- **Store the provider's payload.** Rejected: unreadable after a supplier change.
- **A `TrailStop` that may hold a bare coordinate.** Rejected by the constitution, and
  for a concrete reason: every consumer would have to handle a stop with no name.
- **Fractional indexing for order.** Rejected: solves contention this table will never
  have, at the cost of a representation nobody reads at a glance.
- **A separate `trail_route_snapshots` history table.** Rejected: PR-05 keeps one
  current snapshot per trail. A history of every route a user ever saw is a movement
  record, and §19 says not to build one.

## Consequences

- A trail resumes from a single `GET`, with no memory of the session that built it —
  which is what makes "close the app, come back tomorrow" work with no sync protocol.
- `PlacesModule` now exports two narrow read capabilities and still not its repository:
  discovery asks a spatial question, trails resolve a Place id. Neither can write one.
- The route snapshot's columns are null together or set together, enforced by a CHECK:
  half a snapshot would let a screen render a distance with no line.
- A Trail can exist without a route, and exactly one path produces that — creation
  while the provider was unreachable. `routeIsCurrent` makes it visible rather than
  something a screen has to infer.
