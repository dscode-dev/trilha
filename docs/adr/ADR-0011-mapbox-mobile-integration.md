# ADR-0011 — Mapbox Maps SDK for rendering, Trilha for Places

**Status:** Accepted (PR-02, 2026-09-04)

## Context

Trilha is a map-first product, and PR-00 froze Mapbox into the V1 stack. PR-02 is
where that becomes real code. Two questions had to be settled: how the SDK is
integrated on both platforms, and — more importantly — what it is allowed to be
responsible for.

## Decision

**`mapbox_maps_flutter` 2.30.0**, the official SDK, at latest stable.

**Mapbox renders. It is not a source of Places** (§75). Markers, search results and
detail all come from Trilha's own API against PostGIS. Mapbox's Search/Geocoding
products are deliberately unused: a Place in Trilha carries provenance, a contributor
and a lifecycle, and a third-party POI is none of those. Mixing them would make
"where did this record come from?" unanswerable — the question the constitution's
provenance rule exists to keep answerable.

**The SDK is reached through a narrow seam**, `MapCamera`, exposing camera intent and
viewport reporting. It is not a wrapper around Mapbox: gestures, styling and rendering
stay with the SDK. The seam exists so viewport logic can be tested without a platform
view (§63), and it is two methods wide.

**Viewport queries are debounced and cancellable** (§44). A pan emits camera changes
continuously; the controller waits for the camera to settle, ignores drift too small
to change what is drawn, and cancels the request in flight when a newer viewport
arrives. A superseded response is discarded rather than rendered, so a slow early
query cannot repaint markers for a viewport the user has already left.

**No clustering in V1** (§47). The map returns at most 300 markers per viewport and
reports `truncated` when it capped. At Trilha's current data volume clustering would
add a rendering mode to maintain for no visible benefit. Tracked as
`V1_FUTURE_PR`; the server-side cap is what keeps the map usable until then.

### Platform requirements found by building, not by reading

- **Android `compileSdk 37`.** The Mapbox AAR declares it and the build fails outright
  below it. Pinned in `android/app/build.gradle.kts`.
- **iOS deployment target 14.0**; the Runner project targets 15.0, so it is satisfied.
- **iOS needs Xcode ≥ 17.** MapboxMaps 11.30.0 ships binary XCFrameworks built with
  Swift 6.2.4, and a Swift binary framework requires a consuming compiler at least as
  new. Xcode 16.2 (Swift 6.0.3) fails with
  `Failed to build module 'MapboxCommon'; this SDK is not supported by the compiler`.
  This is a toolchain requirement the SDK imposes, not something the app can work
  around — and the alternative, pinning an older Mapbox to suit one machine's Xcode,
  would trade a documented prerequisite for a silently stale dependency.
- **A Gradle workaround is required.** `mapbox_maps_flutter@2.30.0` skips applying
  `kotlin-android` when AGP ≥ 9, on the assumption Kotlin is then built in, but still
  uses the top-level `kotlin { }` extension that only the Kotlin Gradle plugin
  registers. On Flutter 3.47's AGP 9.1 this fails with
  `Could not find method kotlin()`. The root `build.gradle.kts` applies KGP to that
  one subproject; Flutter's own output confirms the diagnosis by pointing plugin
  authors at its built-in-Kotlin migration guide. Scoped to the single project and
  removable once upstream fixes the guard.
- **No download token is needed.** Mapbox v11 release artefacts resolve from a public
  Maven repository; only the snapshots repository requires `SDK_REGISTRY_TOKEN`.
  Verified by building with no credentials configured.

### Token handling (§37)

The map needs a **public** token (`pk.`), supplied at build time via
`--dart-define=MAPBOX_ACCESS_TOKEN`. A public token is designed to ship inside a
client and is visible to anyone who has the app, which is why it must be
URL-restricted in the Mapbox dashboard. A **secret** token (`sk.`) grants account
access and must never appear in a build — `MapConfig` exposes `tokenLooksSecret` so
that mistake is detectable rather than silent.

With no token the app renders an explanation instead of a blank rectangle, because a
blank rectangle reads as a bug in Trilha.

## Alternatives

- **Google Maps.** Rejected: the stack was frozen on Mapbox in PR-00, and nothing
  found here justifies reopening it.
- **`flutter_map` with raster tiles.** Rejected: fewer native requirements, but loses
  vector styling, and Trilha will need custom cartography for trails.
- **Mapbox Search for place lookup.** Rejected: see above. It is a different product
  answering a different question.
- **A full Mapbox wrapper class.** Rejected: it would have to grow to match the SDK,
  and every gap would be discovered at the wrong moment.

## Consequences

- Mapbox can be replaced by reimplementing `MapCamera` and one widget; nothing in the
  domain or the controller knows it exists.
- Panning produces one request per settled viewport, not one per frame.
- The Gradle workaround is upstream debt to remove, and is documented where a reader
  of the build file will find it.
- **iOS carries a hard toolchain floor of Xcode 17.** Recorded in the README and the
  technology baseline so it is discovered when reading, not when building.
- Runtime rendering could not be verified here: no Mapbox account token and no
  attached device. The surfaces around the map are covered by tests; the Android
  build proves the SDK integrates and links.
