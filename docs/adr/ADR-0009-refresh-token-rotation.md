# ADR-0009 — Single-use refresh rotation with database-enforced concurrency

**Status:** Accepted (PR-01, 2026-09-04)

## Context

A refresh token is a long-lived bearer credential. If one is captured — from a device
backup, a compromised store, a proxy log — the holder has the account for as long as
the token lives. Rotation limits that window; detecting *reuse* is what turns a theft
into a signal instead of a silent takeover.

Rotation introduces a race the design must survive. A mobile client that fires several
requests at once can hit a expired access token on all of them, and every one of those
will try to refresh with the same token. If two rotations both succeed, the model is
broken: two live successors mean the single-use property never held. If the client
replays a consumed token, the server cannot distinguish "thief replaying" from
"legitimate client that lost a race" — and must assume the worse.

## Decision

**Storage.** Only `sha256(token)` is persisted. SHA-256, not Argon2 — the token is 256
uniform random bits from the CSPRNG, so there is no dictionary to run and no work
factor worth paying. The only property needed is that a database leak yields no usable
tokens. Argon2 here would add ~90 ms to the hot path and buy nothing.

**Rotation is single-use.** Refreshing consumes the presented token and issues a
successor, linked via `replaced_by_token_id` so a chain stays walkable.

**Concurrency is settled by PostgreSQL, not by application code.** One conditional
statement claims the token:

```sql
UPDATE refresh_tokens rt SET used_at = now()
  FROM sessions s
 WHERE rt.token_hash = $1
   AND rt.used_at IS NULL          -- the claim
   AND rt.expires_at > now()
   AND s.id = rt.session_id
   AND s.revoked_at IS NULL
   AND s.expires_at > now()
RETURNING rt.id, rt.session_id
```

Both transactions target the same row; PostgreSQL grants the row lock to one. The
winner sets `used_at` and commits. The loser is released, re-evaluates the predicate
against the committed row under READ COMMITTED, finds `used_at IS NOT NULL`, and
updates zero rows. **Exactly one caller can win, by construction.** No advisory lock, no
`SELECT … FOR UPDATE` dance, no application mutex — and therefore nothing that breaks
when a second API instance is added.

Session validity is part of the same statement, so a revoked session cannot have a
token rotated out of it even if the token itself still looks fine.

**Reuse policy.** A token that exists but is already consumed means either theft or a
lost race — indistinguishable, so both are treated as compromise: **the session is
revoked**, every token under it dies with it, the caller is rejected with
`SESSION_EXPIRED`, and `REFRESH_REUSE_DETECTED` is written to the audit trail and
logged at `warn`.

A legitimate client that lost a race is signed out too. That is the intended trade:
the alternative leaves a thief holding a live session, and being asked to sign in again
is a far smaller harm than that.

**The session is the token family.** Revoking the session is revoking the family; no
separate family table earns its place.

**Client side.** The app collapses concurrent refreshes onto one in-flight future, and
a caller whose access token has already been replaced by another rotation takes the
current token rather than rotating again. Ten simultaneous 401s therefore produce one
rotation, not ten — verified by test. Without that the client would rotate ten times in
sequence: not a reuse violation, but ten wasted round trips.

## Alternatives

- **Non-rotating long-lived refresh tokens.** Rejected: a captured token is valid until
  expiry, and there is no signal that it was captured.
- **Application-level locking (mutex, advisory lock).** Rejected: correct only while
  the lock is shared, which stops being true the moment the API scales past one
  process. The row predicate is correct at any instance count.
- **`SERIALIZABLE` isolation.** Rejected: would work, but imposes retry handling across
  the whole transaction for a guarantee one predicate already provides.
- **Revoke only the replayed token, not the session.** Rejected: leaves the thief's
  successor token live, which defeats the point of detection.
- **A grace window where a just-rotated token still works.** Rejected: it is exactly the
  window an attacker needs, and it makes reuse undetectable by design.
- **Storing refresh tokens with Argon2.** Rejected: see above — cost without benefit for
  a high-entropy random value.

## Consequences

- Two concurrent refreshes cannot both succeed. Proven by integration tests at 2, 10,
  25 and 50-way concurrency over real sockets, and asserted at the database level
  (`used_at` set exactly once).
- Reuse costs the legitimate user a sign-in. Documented, and surfaced in the app as
  "your session ended for security reasons" rather than a generic error.
- Logout is immediate for refresh, but an already-issued access token stays valid until
  it expires — at most ten minutes. Closing that window would require a revocation
  check on every authenticated request, putting Redis on the critical path of all
  traffic for a bounded exposure the short TTL already caps. The auth guard does verify
  session liveness, so a revoked session's access token *is* rejected; the residual
  window applies only to the token's own expiry.
- `REFRESH_REUSE_DETECTED` in the audit trail is a genuine security signal and should
  be alerted on when monitoring is introduced.
