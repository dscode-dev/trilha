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
| `DISCOVERY_MAX_SPATIAL_CANDIDATES` | Places the spatial query may return before any provider call (default 100). |
| `DISCOVERY_MAX_DETOUR_CANDIDATES` | Of those, how many are worth paying to measure a detour for (default 20). Must not exceed the spatial cap. |
| `DISCOVERY_PROVIDER_CONCURRENCY` | Parallel provider calls per discovery request (default 4). |
| `DISCOVERY_DEFAULT_MAX_DETOUR_MINUTES` / `DISCOVERY_MAX_DETOUR_MINUTES` | Detour ceiling and its maximum (defaults 30 / 120). Startup fails if the default exceeds the maximum. |
| `DISCOVERY_MAX_RESULTS` | Candidates returned regardless of how many were evaluated (default 20). |
| `RATE_LIMIT_DISCOVERY_*` | Hourly ceilings for discovery — stricter than routing, because each call costs strictly more. |
| `RATE_LIMIT_TRAIL_*` | Ceilings for trail mutations, on a short window: each composition change spends a routing call, and a stuck retry loop is a burst rather than a steady rate. |

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

## Discovery

```
Flutter (origin + destination)  ──▶  POST /discovery/routes   (session required)
                                          │
                        Routing Core  ──▶  route geometry           1 provider call
                                          │
                        PostGIS: ST_DWithin(location, line::geography, width)
                                          │            GIST index, capped at 100
                        RouteCostProvider (port)  ──▶  travel-cost matrix
                                          │            1 provider call, ≤20 candidates
                        RouteRelevancePolicyV1  ──▶  ranked RouteCandidate[]
```

Answers the question the platform exists for: **given a route, which Places are worth
stopping at on the way?**

- **Proximity is a filter; detour is the signal.** A Place 2 km off the line across a
  river is 25 minutes of driving; one 4 km off on the same highway is 7. Straight-line
  distance cannot tell them apart, so Trilha asks what a diversion actually costs.
- **Everything free happens before anything billed** (ADR-0014). Spatial filtering,
  status, category and endpoint checks all run in PostGIS; only what survives reaches a
  metered provider. The order is the design.
- **The backend computes the route it searches along.** Clients send two coordinate
  pairs, never a geometry: an attacker-supplied LineString is an attacker-chosen search
  area over a metered pipeline.
- **`RouteCandidate` is never persisted**, and PR-04 adds no migration. Relevance is a
  property of a *pairing* — `score(place, route, policy)` — so `places.relevance_score`
  would have to mean "relevant in general", which is not a claim Trilha can make.
- **Nothing about the journey is recorded.** No origin, no destination, no geometry, no
  candidates, no selection. Logs carry counts, timings and the policy version only.

### Worst-case provider cost per request

| Stage | Calls |
| --- | --- |
| Route calculation (Directions) | 1 |
| Detour evaluation (Matrix: 20 candidates ÷ 23 per call) | 1 |
| **Total** | **2** |

Bounded by four independent ceilings — spatial candidates, detour candidates, provider
concurrency and an hourly rate limit — none of which depends on how many Places exist.
The Matrix API carries 25 coordinates per driving request, so origin, destination and
23 via-points fit in one call.

### The ranking, in full

```
score = 0.60 · detourEfficiency + 0.25 · proximity + 0.15 · placement

detourEfficiency = 1 − clamp(detourSeconds     / maxDetourSeconds, 0, 1)
proximity        = 1 − clamp(distanceFromRoute / corridorWidth,    0, 1)
placement        =     clamp(min(p, 1 − p)     / 0.15,             0, 1)
```

Deterministic, bounded to `[0, 1]`, sorted `score DESC, detour ASC, placeId ASC`. No
model, no learned weights, no embeddings. Weights live in code and the response names
the policy (`"v1"`), because two deployments must not rank the same route differently
with nothing to explain it.

Provenance, category and description length contribute **nothing** — origin is not
quality, and text length is not either. Ratings, reviews and safety do not exist in the
product yet and are not approximated (ADR-0015).

### Explainability

Candidates carry reason codes — `ON_ROUTE`, `VERY_CLOSE_TO_ROUTE`, `LOW_DETOUR`,
`MODERATE_DETOUR`, `GOOD_ROUTE_POSITION`, `EARLY_IN_ROUTE`, `LATE_IN_ROUTE` — and the
client owns the wording. The **score itself is never shown**: "+7 min" is actionable,
`0.91423` reads as a quality rating and is not one.

### Why discovery requires a session, and a stricter limit than routing

Each call spends a route calculation *and* a matrix request. Reusing the routing
ceiling would let a client convert its routing budget into twice the upstream spend.
The window is an hour rather than the shared short one: planning a trip is an
occasional deliberate act, so a per-minute ceiling would either bound nothing or punish
someone adjusting a filter.

### Baseline

At **40,000 Places**: spatial retrieval **45 ms**, 100 candidates, ranking **2 ms**,
one provider call for detour. `npm run test:integration -- discovery-benchmark`
reproduces it.

### Using it in the app

Calculate a route, then tap **Descobertas**. The sheet lists what is worth stopping at
with the extra time each adds; category chips re-run the search against the same route.
Tapping a card highlights its marker on the map, and clearing the route clears the
suggestions with it.

## Trails

```
Flutter (Trail Builder)  ──▶  POST /trails                      (session required)
                                   │
                       read → propose → route → commit
                                   │         │
                                   │         └─ provider call, no transaction open
                                   └─ compare-and-set on `revision`
```

The first thing a user **owns**. Everything before this — a route, a set of
suggestions — is derived and disposable; a Trail is a decision someone made and asked
to keep.

- **A Trail is not a Route** (ADR-0016). Routing answers *how to get there*; a Trail
  records *what was chosen*: which places, in which order. It keeps a **snapshot** of
  what routing last said, so a road closing overnight cannot silently rewrite a saved
  journey.
- **A stop is always a resolved Place.** Never a coordinate, never free text. Tapping
  somewhere with no Place leads to the contribution flow, not to a weaker stop.
- **Order is explicit.** A 1-based contiguous `position`, never insertion time — a
  reorder creates nothing, so `createdAt` stops describing the sequence the moment a
  row is dragged.
- **At most 15 stops.** The provider accepts 25 coordinates per request and origin and
  destination take two; fifteen leaves margin, and is also as many as a person will
  reorder by hand.
- **Nothing is published.** `FINALIZED` means the user stopped composing. There is no
  visibility flag, no slug, no share count — publication is a later PR with rules of
  its own.

### Lifecycle

```
DRAFT ──finalize──▶ FINALIZED ──any edit──▶ DRAFT
  └──────────────── archive ─────────────────▶ ARCHIVED
```

Editing a finished Trail reopens it, which keeps "finished" an honest description of
the current state rather than a one-way door.

### Revisions, and why every mutation carries one

Every Trail has a `revision`, incremented once per accepted change. Clients send the
revision they are editing, and the server writes only if it still holds — as a
predicate on the `UPDATE`, not a read followed by a write:

```sql
UPDATE trails SET revision = revision + 1, …
 WHERE id = $1 AND owner_user_id = $2 AND revision = $expected
```

Two simultaneous edits at the same revision produce **one 200 and one 409**. A
conflict is answered by reloading, never by merging: a lost update is worse than a
retry because nobody finds out about it.

`routeRevision` records which composition the stored route describes. Equal to
`revision` means the drawn line matches; the API exposes this as `routeIsCurrent`.

### The transaction boundary

```
1. read      the trail, owner-scoped, check the revision
2. propose   the composition it would have — in memory
3. route     ask the provider                    ← no transaction open
4. commit    one short transaction: CAS, apply, snapshot
```

**No external call ever happens inside a transaction.** Holding one open across an
HTTP request to Mapbox would pin a connection for as long as the provider takes, and a
slow upstream would drain the pool rather than merely be slow.

**A failed route writes nothing.** The composition change and the snapshot that
describes it land together or not at all — a trail carrying a stop it has no route
through would draw a line that omits somewhere the user chose to go.

### Privacy

This is the first place Trilha persists travel intent, and the distinction matters:

| Not persisted | Persisted, because the user asked |
| --- | --- |
| Routes calculated and never saved | A Trail's origin, destination and stops |
| Discovery queries and their results | Its route snapshot |
| Device position used to centre a map | — |
| Any GPS history or movement trace | — |

Saving a Trail is someone choosing to keep a plan. That is a different thing from
tracking, and the difference is that they asked. Logs carry counts and revisions only:
no geometry, no coordinates, no trail or user id in a metric label.

### Using it in the app

Calculate a route, tap **Montar trilha**, then add stops from **Descobertas pelo
caminho** or by searching. Drag to reorder — one request per completed drag, not one
per frame — and the route redraws with the new totals. Everything saves as you go, so
**Concluir** marks it finished rather than saving it. **Minhas trilhas** lists what you
have built; opening one restores the whole builder from a single read.

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

**Discovery returns 200 with no candidates.** Usually working as intended: nothing
active sits inside the corridor within the detour ceiling. Widen
`corridorWidthMeters`, raise `maxDetourMinutes`, or clear the category filter. An
outage returns 502, never an empty list.

**Discovery is slow, or upstream cost is higher than expected.** The response
`diagnostics` block shows how the funnel narrowed —`spatialCandidates`,
`evaluatedCandidates`, `returnedCandidates` — and the log line adds `spatialQueryMs`,
`detourEvaluationMs` and `rankingMs`. If `spatialCandidates` is at the cap, the
corridor is wider than it needs to be.

**Startup fails with `DISCOVERY_MAX_DETOUR_CANDIDATES must not exceed …`.** Working as
intended: evaluating more candidates than the spatial query can return means one of
the two ceilings is a lie about what the pipeline does.

**A trail mutation returns 409 `TRAIL_REVISION_CONFLICT`.** Working as intended: the
trail changed since the revision you sent. Re-read it, look at what moved, and decide
again — the server will not merge for you, because merging would have to guess intent.

**A trail mutation returns 502 and nothing changed.** Also intended. The composition
change and the route that describes it are written together or not at all, so a
provider outage leaves the previous composition exactly as it was. Retry, or use
**Atualizar rota** once the provider is back.

**`Concluir` is disabled with `TRAIL_ROUTE_STALE`.** The stored route does not describe
the current composition — the one way this happens is a trail created while the
provider was unreachable. Tap **Atualizar rota** first.

**Adding a stop returns 422 `TRAIL_STOP_PLACE_UNAVAILABLE`.** The Place is archived or
does not exist. Trails already holding it keep it; it just cannot be added to a new
one.

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
| `docs/adr/ADR-0014-…` | The discovery pipeline, and where money may be spent |
| `docs/adr/ADR-0015-…` | Route relevance policy v1, weights and all |
| `docs/adr/ADR-0016-…` | A Trail is composition, not calculation |
| `docs/adr/ADR-0017-…` | Revisions, and never holding a transaction across a network call |

## Contributing

Read `docs/constitution.md` first. It is binding, and departures require an ADR.
