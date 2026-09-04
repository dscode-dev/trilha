# Trilha

Geospatial trail platform. Flutter client, NestJS modular-monolith API, PostgreSQL +
PostGIS, Redis.

**Current state: PR-02 — geographic foundation and Places.** A person can open a real
map, explore it with or without granting location, see Places served from PostGIS,
search them, open their details, and contribute new ones. Routing, trails, reviews and
safety do not exist yet — that is deliberate, see `docs/constitution.md`.

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24.20.0 LTS | `.nvmrc` pins it; `nvm use` |
| Flutter | 3.47.2 stable | Bundles Dart 3.13.2 |
| Docker | with Compose v2 | For PostgreSQL and Redis |
| Make | any | Optional; every target is a plain command |

Exact versions and why each was chosen: `docs/technology-baseline.md`.

For iOS builds: **Xcode 17 or newer** — MapboxMaps 11.30 ships Swift 6.2 binary
frameworks, which Xcode 16 cannot consume (see `docs/technology-baseline.md`).
For Android builds: the Android SDK **including cmdline-tools**
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
either auth secret or the routing token left at its placeholder value.

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
| `RATE_LIMIT_*` | Per-window ceilings for the auth and routing endpoints. |
| `MAPBOX_ROUTING_ACCESS_TOKEN` | Server-side token for the Directions API. **Not** the mobile map token — see "Routing" below. |
| `ROUTING_PROVIDER_TIMEOUT_MS` | Upstream call ceiling (default 8000). An unbounded provider call holds a request, a connection and a socket. |
| `ROUTING_CORRIDOR_DEFAULT_METERS` / `ROUTING_CORRIDOR_MAX_METERS` | Corridor half-width and its ceiling (defaults 5000 / 20000). Startup fails, in any environment, if the default exceeds the maximum. |

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
| GET | `/api/v1/places/categories` | The category vocabulary. Public. |
| GET | `/api/v1/places/map` | Places inside a viewport — the map query. Public. |
| GET | `/api/v1/places/nearby` | Places within a radius, nearest first. Public. |
| GET | `/api/v1/places/search` | Name search, accent- and case-insensitive. Public. |
| GET | `/api/v1/places/:id` | One place with its provenance. Public. |
| POST | `/api/v1/places` | Contribute a place. **Requires a session.** |
| GET | `/docs` | OpenAPI UI, when `SWAGGER_ENABLED=true`. |

## Places and geography

```
Flutter (Mapbox renders)  ──▶  GET /places/map?north=…&south=…&east=…&west=…
                                     │
                          PostGIS: location && envelope::geography  → GIST index
```

- **PostGIS is the spatial source of truth.** `geography(Point, 4326)`, so distances
  are real metres on the spheroid rather than degrees. Marco Zero → Igreja da Sé
  measures 6,242 m, which is the ground truth.
- **The API speaks degrees**; Web Mercator never leaves the map renderer.
- **Reads are public, contributing needs a session.** A first-time visitor can explore
  the map without an account.
- **Provenance is recorded on every Place** and set by the server — a client claiming
  `SYSTEM` is ignored.
- **Search is accent-insensitive**: "sao paulo" finds "São Paulo", via a generated
  column and a trigram index.
- **Near-duplicates are advisory.** Submitting a similar name nearby returns what
  looks alike; it never blocks, because two restaurants sharing a name in different
  cities are two places.
- **Mapbox renders; it is not a source of Places** (ADR-0011).

Baseline at 40,007 places: viewport 3.7–4.2 ms, radius 45–69 ms, search 12–17 ms.

### Running the map

The map needs a **public** Mapbox token (`pk.`), supplied at build time and never
committed:

```bash
cd apps/mobile
flutter run --dart-define=MAPBOX_ACCESS_TOKEN=pk.your_public_token
```

Without one the app explains what is missing rather than showing a blank rectangle.
Restrict the token by URL in the Mapbox dashboard. A **secret** token (`sk.`) grants
account access and must never be built into a client.

### Location

Foreground only. Trilha asks for permission when the user taps "show my location",
centres the map, and discards the position — it is never persisted and never sent to
the server. `ACCESS_BACKGROUND_LOCATION` is deliberately absent from the manifest.
Denying permission leaves the map fully usable.

## Routing

```
Flutter (origin + destination)  ──▶  POST /routes/calculate   (session required)
                                          │
                              RoutingProvider (port)  ──▶  Mapbox Directions
                                          │
                          PostGIS: ST_Buffer(line::geography, metres)  → corridor
```

- **The provider is behind a port** (ADR-0012). `RoutingProvider` is the only thing
  callers depend on; nothing outside `modules/routing/infrastructure/` knows which
  provider is in use. The generated OpenAPI document contains neither `mapbox` nor
  `access_token`, and a test asserts it.
- **A route is not a Trail.** Geometry, distance, duration, legs, bounds and an
  optional corridor. No name, no author, no stops, no alternatives, no navigation.
- **Nothing is persisted.** A route is recalculated, not recalled — PR-03 adds no
  migration. Storing every calculation would build a record of where people intend
  to go (constitution §57).
- **The corridor is buffered in metres, on `geography`.** `ST_Buffer` on a 4326
  *geometry* reads 5000 as 5000 *degrees* and silently returns ~221,000,000 km²
  instead of ~1,128 km². The cast is the whole feature (ADR-0013).
- **Provider errors are normalised.** `ROUTE_NOT_FOUND`, `INVALID_ROUTE_REQUEST`,
  `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED`. An expired
  platform credential surfaces as unavailable, never as a 401 the caller might try
  to fix by signing in again.
- **Endpoints are never logged**, and never appear in a metric label. Distance is
  bucketed before it becomes a label so cardinality stays bounded.

### The routing token is not the map token

Two different Mapbox credentials, with two different threat models:

| | Mobile map | Backend routing |
| --- | --- | --- |
| Variable | `MAPBOX_ACCESS_TOKEN` (`--dart-define`) | `MAPBOX_ROUTING_ACCESS_TOKEN` (`.env`) |
| Type | Public (`pk.`) | Restricted, Directions scope only |
| Where it lives | Inside the shipped app, world-readable by design | Server-side only |

Create the routing token in the Mapbox dashboard with the **Directions** scope and
nothing else, then:

```bash
# apps/api/.env — never committed
MAPBOX_ROUTING_ACCESS_TOKEN=pk.your_directions_scoped_token
```

Reusing the app's map token here would put a spendable credential in an APK.

### Why routing requires a session

`POST /routes/calculate` sits behind `AuthGuard` and a routing-specific rate limiter
with per-user *and* per-IP ceilings. Unlike Places, every routing call spends money at
a third party, so an anonymous endpoint would be a free public proxy to a metered API
— discoverable by anyone who reads the OpenAPI document.

### Using it in the app

Tap the directions button, choose an origin and a destination — your location, the
centre of the map, or any Place marker — and request the route. Distance and duration
appear as `121 km · 1h48`; the camera frames the whole line. Swapping the endpoints
does not recalculate on its own, and clearing the route leaves the Places on the map
untouched.

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

**The app shows "The map needs a Mapbox token".** Working as intended — pass
`--dart-define=MAPBOX_ACCESS_TOKEN=pk.…`.

**Android build fails with `Could not find method kotlin()`.** `mapbox_maps_flutter`
2.30.0 has an AGP 9 incompatibility; the workaround lives in
`apps/mobile/android/build.gradle.kts` and is documented in
`docs/technology-baseline.md`. Do not delete it until the plugin is fixed upstream.

**iOS build fails with `Failed to build module 'MapboxCommon' … not supported by the
compiler`.** Xcode is older than 17. Mapbox's binary frameworks are built with Swift
6.2 and require a matching or newer toolchain. Android is unaffected.

**A viewport query returns 400.** The viewport is larger than 5° or crosses the
antimeridian. Both are rejected explicitly rather than returning a silently empty or
very slow result.

**Routing returns `PROVIDER_UNAVAILABLE` on every request.** The most likely cause is
`MAPBOX_ROUTING_ACCESS_TOKEN`: upstream 401 and 403 are deliberately reported as
unavailable rather than passed through, because the caller's credentials are not the
problem. Check the token's scope includes Directions. The provider URL is never
logged, since it carries the token.

**Routing returns `INVALID_ROUTE_REQUEST` for two points that look fine.** They are
closer than 25 m apart — below GPS noise, so there is nothing to route — or further
apart than 5,000 km, which almost always means a latitude and longitude were swapped.
Both are rejected before spending an upstream call.

**A corridor comes back the size of a continent.** `ST_Buffer` was applied to the
geometry rather than to `::geography`, so the width was read as degrees. See
ADR-0013; an integration test guards against this.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/constitution.md` | Binding engineering and domain principles |
| `docs/technology-baseline.md` | Exact versions, why, and when to revisit |
| `docs/design-foundation.md` | Palette and tokens derived from `logo.png` |
| `docs/adr/` | Architecture decision records |
| `apps/mobile/lib/features/README.md` | Feature-slice conventions |
| `docs/adr/ADR-0012-…` | Why routing sits behind a port |
| `docs/adr/ADR-0013-…` | Route geometry on the wire, and the corridor in metres |

## Contributing

Read `docs/constitution.md` first. It is binding, and departures require an ADR.
