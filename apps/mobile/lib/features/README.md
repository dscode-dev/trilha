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

- `root/` — the institutional root surface. It exists to prove the foundation renders;
  it is not a product feature and will be replaced once real destinations land.

Everything else arrives with the PR that owns it (PR-01 onward). This directory is
deliberately not pre-populated with empty folders for features that do not exist.
