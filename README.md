# Trilha

Geospatial trail platform. Flutter client, NestJS modular-monolith API, PostgreSQL +
PostGIS, Redis.

**Current state: PR-01 — identity, session and profile.** A person can create an
account, stay signed in across restarts, edit their profile, change their password and
sign out. No other product domain exists yet — that is deliberate, see
`docs/constitution.md`.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24.20.0 LTS | `.nvmrc` pins it; `nvm use` |
| Flutter | 3.47.2 stable | Bundles Dart 3.13.2 |
| Docker | with Compose v2 | For PostgreSQL and Redis |
| Make | any | Optional; every target is a plain command |

Exact versions and why each was chosen: `docs/technology-baseline.md`.

For iOS builds: Xcode. For Android builds: the Android SDK **including cmdline-tools**
(Android Studio → SDK Manager → SDK Tools → *Android SDK Command-line Tools*), then
`flutter doctor --android-licenses`.

## Repository layout

```
apps/
  api/                  NestJS modular monolith
    src/
      modules/          bounded contexts (PR-00 ships only `health`)
      common/           errors, http, logging, validation
      infrastructure/   database, cache, config, observability
  mobile/               Flutter client
    lib/
      app/              bootstrap, config, navigation, theme
      core/             networking, errors, logging, observability
      features/         feature-first slices (see lib/features/README.md)
      shared/           reusable widgets
packages/
  contracts/            generated OpenAPI document
infra/local/            docker-compose stack
docs/                   constitution, ADRs, technology baseline
logo.png                official brand asset (source of truth)
```

## Setup from a fresh clone

```bash
git clone <repo> && cd Trilha

# 1. API dependencies
cd apps/api && npm ci && cp .env.example .env && cd ../..

# 2. Mobile dependencies
cd apps/mobile && flutter pub get && cd ../..

# 3. Infrastructure + API
make up            # or: docker compose -f infra/local/docker-compose.yml up -d --build

# 4. Verify
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/ready
```

`make up` builds the API image, waits for PostgreSQL and Redis to report healthy, applies
migrations, then starts the API. No hidden steps.

## Environment

`apps/api/.env.example` documents every variable. Copy it to `.env` and adjust.
**`.env` is git-ignored and must never be committed.**

Configuration is validated by Zod at startup: a missing or malformed variable **stops
the process** with a report naming each offending field. There is no `process.env`
access anywhere else in the codebase.

Production additionally refuses to start with `CORS_ORIGINS=*`, `LOG_PRETTY=true`, or
either auth secret left at its placeholder value.

Generate real secrets before anything beyond local development:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

| Variable | Purpose |
| --- | --- |
| `JWT_ACCESS_SECRET` | HMAC key for access tokens. Never generated at boot — a per-instance secret would invalidate every token on restart. |
| `JWT_ISSUER` / `JWT_AUDIENCE` | Validated on every token; a token minted for another audience is rejected. |
| `JWT_ACCESS_TTL_SECONDS` | Access token lifetime (default 600). |
| `REFRESH_TTL_SECONDS` | Refresh token and session lifetime (default 30 days). |
| `IP_HASH_KEY` | Key for the one-way digest of client addresses in audit records. Must differ from `JWT_ACCESS_SECRET`; raw addresses are never stored. |
| `RATE_LIMIT_*` | Per-window ceilings for the auth endpoints. |

## Running the backend

Against Docker infrastructure, with the API from source (fast reload):

```bash
make up-infra                       # postgres + redis only
cd apps/api
npm run build && npm run db:migrate # migrations run from compiled output
npm run start:dev
```

Fully containerised:

```bash
make up
make logs
```

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/v1/health` | Liveness. Touches no dependency; 200 while the process runs. |
| GET | `/api/v1/ready` | Readiness. Probes PostgreSQL and Redis; **503** if either is down. |
| POST | `/api/v1/auth/register` | Create an account and sign it in. |
| POST | `/api/v1/auth/login` | Sign in. Identical answer for unknown account and wrong password. |
| POST | `/api/v1/auth/refresh` | Rotate the session tokens. Single-use. |
| POST | `/api/v1/auth/logout` | End the current session. |
| POST | `/api/v1/auth/logout-all` | End every session, this one included. |
| GET | `/api/v1/me` | The authenticated account and profile. |
| PATCH | `/api/v1/me/profile` | Update displayName, username or bio. |
| POST | `/api/v1/me/change-password` | Change the password; revokes every session. |
| GET | `/docs` | OpenAPI UI, when `SWAGGER_ENABLED=true`. |

## Authentication

```
register / login  ──▶  access token (JWT, 10 min, in memory)
                       refresh token (opaque, 30 days, secure storage)

access expires    ──▶  POST /auth/refresh  ──▶  new pair, old refresh consumed
old refresh replayed ─▶ session revoked + audited  (treated as compromise)
```

- **Access tokens** are short-lived HS256 JWTs carrying only `sub`, `sid`, `iss`,
  `aud`, `iat`, `exp`. The guard also verifies the session is still live, so logout
  takes effect immediately for both refresh and access.
- **Refresh tokens** are 256-bit random values. Only a SHA-256 digest is stored.
  Rotation is single-use, and concurrency is settled by a conditional `UPDATE` in
  PostgreSQL — two simultaneous refreshes cannot both succeed.
- **Reusing a rotated token revokes the whole session** and writes
  `REFRESH_REUSE_DETECTED` to the audit trail. See `docs/adr/ADR-0009-refresh-token-rotation.md`.
- **Passwords** use Argon2id at `m=46 MiB, t=3, p=1` (benchmarked; ADR-0008).
- **Rate limiting** is Redis-backed and distributed. Login is limited per source *and*
  per source+account — never per account alone, which would let anyone lock out any
  user.

**Password reset is not implemented.** It needs email delivery, which does not exist
yet, and §25 rules out a fake token flow. Tracked as `V1_FUTURE_PR`.

## Running the app

```bash
cd apps/mobile
flutter run                                          # development flavor
flutter run --dart-define=TRILHA_ENV=staging         # staging
```

The Android emulator cannot reach the host as `localhost`:

```bash
flutter run --dart-define=TRILHA_API_BASE_URL=http://10.0.2.2:3000/api/v1
```

## Migrations

Migrations are plain SQL under `apps/api/src/infrastructure/database/migrations/`,
applied by an explicit runner. PostGIS is enabled by migration `0000`, not by a
container entrypoint, so a managed PostgreSQL provisions identically.

```bash
cd apps/api
npm run build && npm run db:migrate   # apply
npm run db:generate                   # generate from schema changes (never auto-applies)
```

Rebuilding from empty:

```bash
make clean && make up
```

Migrations are applied in order from `0000`; PR-01's `0001_identity` runs cleanly on
both an empty database and one already carrying PR-00's schema.

## Tests

```bash
# API
cd apps/api
npm run test              # unit — no infrastructure needed
npm run test:integration  # requires `make up-infra`

# Mobile
cd apps/mobile
flutter test
```

Integration tests use real PostgreSQL, PostGIS and Redis. They deliberately do not mock
the dependencies they exist to prove — including a genuine geodesic distance
calculation, a GIST-indexed spatial query, readiness returning 503 against a closed
port, and refresh rotation under 50-way concurrency over real sockets.

Mobile tests fake only the HTTP boundary and secure storage, since a test binding has
neither a network nor a Keychain. Everything above those two seams — the controller,
the router, the screens — is the production code.

## Lint, format, typecheck

```bash
make check          # everything

cd apps/api
npm run format:check && npm run lint && npm run typecheck

cd apps/mobile
dart format --output=none --set-exit-if-changed lib test && flutter analyze
```

Warnings are errors: the API lints with `--max-warnings 0` and CI analyses Flutter with
`--fatal-infos --fatal-warnings`.

## Builds

```bash
cd apps/api && npm run build              # dist/
docker compose -f infra/local/docker-compose.yml build api

cd apps/mobile
flutter build apk --debug                 # Android
flutter build ios --debug --no-codesign   # iOS (macOS + Xcode only)
```

## API contract

`packages/contracts/openapi/openapi.json` is generated from the running Nest metadata —
never hand-edited. CI fails if it is stale.

```bash
make openapi
```

## Troubleshooting

**`ready` returns 503.** Working as designed — a dependency is down. The response names
which. `make ps` shows service health; `make logs` shows why.

**PostgreSQL container restarts on startup.** Usually a volume created against a
pre-18 layout. PostgreSQL 18+ images mount at `/var/lib/postgresql`, not
`/var/lib/postgresql/data`. `make clean` removes the stale volume.

**Port already in use.** Override before starting:
`POSTGRES_PORT=55432 REDIS_PORT=56379 API_PORT=3001 make up`.

**API exits immediately with `Invalid environment configuration`.** Intended fail-fast.
The message names each offending variable; compare against `.env.example`.

**`flutter analyze` reports issues after editing.** Run `dart format lib test` first —
the formatter can reflow code into shapes the linter has opinions about.

**Android build fails with missing cmdline-tools.** Install *Android SDK Command-line
Tools* via Android Studio's SDK Manager, then `flutter doctor --android-licenses`.

**`npm ci` warns `EBADENGINE`.** The local Node is not 24.x. `nvm use` picks up
`.nvmrc`.

**API exits with `JWT_ACCESS_SECRET is a known placeholder value`.** Working as
intended: production refuses the example secrets. Generate real ones (see Environment).

**Android build fails with `requires … version 37 or later of the Android APIs`.**
`flutter_secure_storage` needs `compileSdk 37`; install that SDK platform via Android
Studio's SDK Manager. The pin lives in `apps/mobile/android/app/build.gradle.kts`.

**Signed in, then everything returns 401.** Expected after a password change or
`logout-all`: every session is revoked by design. Sign in again.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/constitution.md` | Binding engineering and domain principles |
| `docs/technology-baseline.md` | Exact versions, why, and when to revisit |
| `docs/design-foundation.md` | Palette and tokens derived from `logo.png` |
| `docs/adr/` | Architecture decision records |
| `apps/mobile/lib/features/README.md` | Feature-slice conventions |

## Contributing

Read `docs/constitution.md` first. It is binding, and departures require an ADR.
