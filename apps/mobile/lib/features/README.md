# Features

Each product capability is one directory here, and each is **feature-first**: a feature
owns its full vertical slice rather than being spread across global `models/`,
`services/` and `widgets/` folders.

## Required layout

```
features/<feature>/
├── domain/        # Entities and rules. Pure Dart — no Flutter, no Dio, no Riverpod.
├── application/   # Use cases and state orchestration.
├── data/          # Repository implementations, DTOs, API/storage adapters.
└── presentation/  # Screens and widgets. No business rules (constitution §Architecture).
```

## Rules

- **Dependencies point inward.** `presentation → application → domain`; `data`
  implements ports declared by `domain`/`application`. `domain` imports nothing from
  the other layers.
- **Riverpod is composition, not architecture** (ADR-0005). Providers wire things
  together and own lifecycle. Business rules live in `domain`/`application`, so they
  stay testable without a `ProviderContainer`.
- **No cross-feature imports.** If two features need the same thing, it belongs in
  `core/` or `shared/`, and moving it there is a deliberate decision — not a shortcut.
- **Create a layer when it earns its place.** A feature with no rules yet does not need
  an empty `domain/`. Directories are not architecture.

## Present today

- `root/` — the launch surface, shown only while a stored session is being restored.
- `auth/` — accounts, sessions and credentials.
- `profile/` — the signed-in user's own profile.
- `places/` — the Place domain: fetching, searching, contributing.
- `map/` — visual geographic orchestration: viewport, camera, selection, device
  location.

### Why `map` and `places` are separate

`places` owns the domain — what a Place *is*, how it is fetched and created. `map`
owns the orchestration — which viewport is showing, where the camera points, what is
selected, whether location was granted.

The dependency runs one way: **`map` uses `places`; `places` knows nothing about a
map.** That is what lets a Place be listed, searched or linked to without a map on
screen, and it is why a future trail-builder can reuse `places` untouched. Merging
them would make every Place read carry map state it does not need.

Everything else arrives with the PR that owns it (PR-01 onward). This directory is
deliberately not pre-populated with empty folders for features that do not exist.
