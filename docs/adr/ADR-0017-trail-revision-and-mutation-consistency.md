# ADR-0017 — Revisions, and never holding a transaction across a network call

**Status:** Accepted (PR-05, 2026-09-05)

## Context

Every Trail mutation is two writes that must agree: a change to the composition, and
the route that describes it. Between them sits an HTTP call to a routing provider.

That shape creates two failure modes, and both are silent.

**Lost updates.** A mobile client retries. It goes offline mid-request and repeats.
Two screens of the same account edit the same trail. In each case the natural
implementation — read the trail, decide, write it back — lets the second write
overwrite the first with nobody finding out. A user watches their stop disappear and
has no way to know why.

**Torn state.** If the stop is written and then the route fails, the trail now claims
a journey through somewhere its line does not go. If the route is computed first and
the write fails, nothing happens, which is fine. The order matters, and so does
whether both land together.

There is also a resource trap. The obvious way to make the two writes atomic is one
transaction — and if the provider call sits inside it, a PostgreSQL transaction stays
open for as long as Mapbox takes to answer. A slow upstream then stops being slow and
starts being an outage, because the connection pool drains.

## Decision

### A monotonic `revision`, and a compare-and-set

Every trail carries `revision`, incremented by exactly one per accepted mutation.
Clients send the revision they believe they are editing; the server writes only if it
still holds.

The check is a **predicate on the UPDATE itself**, not a read followed by a write:

```sql
UPDATE trails
   SET revision = revision + 1, …
 WHERE id = $1 AND owner_user_id = $2 AND revision = $expected
```

Two requests carrying the same `expectedRevision` both reach that statement; exactly
one matches a row, and the other sees `rowCount = 0` and is told to reload. A
`SELECT` then `UPDATE` would let both pass the check and the second silently win.

There is *also* a cheap pre-check before the provider call, so an obviously stale
client is refused without spending a billed request. It is an optimisation, not the
guarantee — a mutation that passes it can still lose the race, and the CAS is what
catches that.

**409, never a merge.** A conflict is news, not an error to retry: the client reloads,
sees what changed, and decides again. Automatic merge would have to guess intent, and
guessing wrong is exactly the lost update this prevents.

### Four steps, and the provider call is outside the transaction

```
1. read      the trail, scoped to its owner, and check the revision
2. propose   the composition it would have — in memory, no I/O
3. route     ask the provider what that costs        ← no transaction open
4. commit    one short transaction: CAS, apply, snapshot
```

Step 2 exists so that step 3 runs against a fully decided composition. Without it, the
natural shape is "write, then route, then write again", which is precisely the shape
that leaves a trail with a stop it has no route for.

Step 4 re-checks the revision because step 3 takes time and another request can commit
during it.

**Nothing external is ever awaited inside a transaction.** The repository takes an
already-computed snapshot and writes it; the call that produced it happened before the
transaction opened.

### A failed route means no write at all

If routing fails, the composition is untouched: no stop row, no revision bump, no
snapshot change. From the user's side the mutation was atomic, which is the only model
worth offering — the alternative is a trail that is half-changed and a UI that has to
explain it.

The cost is that a mutation cannot be applied while the provider is down. That is the
right trade: a stop with no route through it is worse than a stop the user has to add
again in five minutes.

### `routeRevision`, not a `dirty` boolean

The snapshot records which trail revision it describes. Equal to `revision` means the
line matches the composition; less means stale. A boolean carries the same bit and
none of the evidence — this says *which* composition was measured, and a CHECK
constraint can assert it is not a revision that has not happened yet.

Under the atomicity rule above, a successful mutation always leaves the two equal. The
one way they diverge is a trail created while the provider was unreachable, which has
no snapshot at all. Finalizing requires them equal (§22): "I'm done" has to mean the
thing the user was looking at is the thing that gets saved.

### Idempotency: mostly free

`POST /trails/:id/stops` and every other mutation carry `expectedRevision`, so a retry
after a lost response arrives with a revision that has already been consumed and is
refused with 409 — not applied twice. `UNIQUE (trail_id, place_id)` refuses a duplicate
stop independently.

`POST /trails` is the one endpoint with no revision to check, so a retry there can
create a second draft. That is the least harmful duplicate in the system — a draft with
no stops, deletable in one tap — and an `Idempotency-Key` store would be new
infrastructure with its own expiry and storage semantics for that single case. Noted as
debt rather than built.

## Alternatives

- **Last-write-wins.** Rejected: silently loses edits, which is the failure users
  cannot detect.
- **`SELECT … FOR UPDATE` across the provider call.** Rejected: correct, and it holds
  a row lock and a connection for the length of an HTTP request.
- **Server-side merge of concurrent edits.** Rejected: reordering and adding are not
  commutative, and a merge would have to invent an intent nobody expressed.
- **Optimistic write, then compensate on routing failure.** Rejected: compensation is
  another write that can fail, and the window in between is a trail in a state the
  domain says cannot exist.
- **`updated_at` as the concurrency token.** Rejected: timestamp resolution is not a
  guarantee, and two writes inside the same tick would both succeed.

## Consequences

- Two simultaneous mutations at the same revision produce **one 200 and one 409**,
  asserted by an integration test against real PostgreSQL, and by a five-way burst that
  yields one success and four conflicts.
- A routing failure leaves the trail byte-for-byte as it was, asserted by comparing a
  full detail read before and after.
- Clients must carry a revision. Every mutation returns the whole trail, so the next
  one is always available without a second round trip.
- Reorder is one request per completed drag, never one per frame — the same rule the
  server's cost model assumes.
