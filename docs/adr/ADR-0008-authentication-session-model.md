# ADR-0008 — Account, credential, profile and session as separate concerns

**Status:** Accepted (PR-01, 2026-09-04)

## Context

PR-01 introduces the first product domain. The tempting shape is one `users` table
holding email, password hash, display name and a token — it is the smallest thing that
works on day one, and it is very hard to unpick later.

Four questions have genuinely different answers:

- *Who is this account?* — identity, referenced by every future domain.
- *How does the holder prove it?* — a secret, rotated independently of identity.
- *How do they appear to others?* — public presentation, editable at will.
- *Which installs are currently trusted?* — session state, revoked constantly.

## Decision

Four tables: `users`, `credentials`, `user_profiles`, `sessions`, plus
`refresh_tokens` and `auth_audit_events`.

**Identifiers.** PostgreSQL 18's native `uuidv7()`. Non-enumerable as the constitution
requires (§21), and time-ordered, so primary-key inserts stay local in the index
instead of scattering the way uuid v4 does. No dependency: the database generates them.

**Email and username uniqueness** are enforced by `GENERATED ALWAYS AS (lower(...))
STORED` columns carrying the unique index. Application-side normalisation is a
convenience; the generated column is the guarantee, and it cannot be bypassed by a
future service, a data fix, or a raw `INSERT` — verified by test.

The typed value is preserved: identity comes from the folded column, so there is no
reason to discard a user's capitalisation.

**Access tokens** are HS256 JWTs carrying `sub`, `sid`, `iss`, `aud`, `iat`, `exp` and
nothing else. Ten-minute lifetime. No profile data: a bearer token travels through
logs and proxies, and a display name embedded in it goes stale the moment it changes.

`jose` rather than `@nestjs/jwt`: the API is ESM-only (ADR-0007), `jose` is ESM-native
with no CommonJS interop, and issuer/audience validation is explicit rather than
optional.

**Argon2id** via `@node-rs/argon2`, at `m=47104 KiB (46 MiB), t=3, p=1` — measured, not
guessed (see §Benchmark below). The Rust binding ships musl prebuilds, so the Alpine
production image needs no `node-gyp` toolchain, unlike the `argon2` package.

**Anti-enumeration.** Login returns one error for an unknown address and for a wrong
password, and spends comparable time on both — an unmatched address is still verified
against a pre-computed dummy hash, because a microsecond response is as good an oracle
as a distinct message.

Registration *does* disclose that an email or username is taken. That is a deliberate,
narrow exception: a signup form that cannot say "already registered" is unusable, and
the information is obtainable by attempting a signup regardless. Login, the endpoint an
attacker would actually script, discloses nothing.

## Benchmark (§53)

Measured on the reference development machine, 2026-09-04:

| Parameters | Hash | Verify |
| --- | --- | --- |
| m=19 MiB, t=2, p=1 (OWASP floor) | 25 ms | 24 ms |
| **m=46 MiB, t=3, p=1 (selected)** | **89 ms** | **100 ms** |
| m=64 MiB, t=3, p=4 | 50 ms | 47 ms |

The selection lands on the ~100 ms interactive budget and sits well above the OWASP
minimum on the memory axis, which is the axis that actually degrades GPU and ASIC
attacks. `p=1` keeps one login to one core, so throughput is governed by the pool
rather than by threads contending.

**Capacity consequence:** each in-flight hash reserves ~46 MiB. Concurrency is bounded
by the login rate limiter; raising that ceiling means revisiting this number.

## Alternatives

- **One `users` table with everything.** Rejected: a profile read would touch password
  material, and rotating a credential would mean writing the identity row.
- **bcrypt.** Rejected: capped at 72 bytes (silently truncating longer passphrases),
  and no memory-hardness, which is the property that matters against GPUs.
- **`argon2` (node-gyp).** Rejected: compiling native code in the production image
  means shipping a toolchain or a fragile prebuild step; `@node-rs/argon2` publishes
  musl binaries for exactly our base image.
- **UUID v4.** Rejected: equally non-enumerable, but random insertion order fragments
  the primary-key index as the table grows.
- **`citext` for case-insensitive columns.** Rejected: a contrib extension with
  collation caveats, where a generated column plus a unique index is standard SQL and
  equally enforced.
- **Sessions in Redis.** Rejected: the constitution holds that Redis is never a source
  of truth (§5), and a lost cache must not silently sign everyone out.

## Consequences

- A profile read never loads a password hash.
- Adding a second credential type later (passkeys, OAuth) means rows in `credentials`,
  not a migration of `users`.
- Case-insensitive identity is guaranteed by the database, not by remembering to call
  `toLowerCase()`.
- Registration is an availability oracle. Accepted, documented, and confined to that
  one endpoint.
- Argon2's memory cost is real capacity planning, not a constant to raise casually.
