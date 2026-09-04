# ADR-0002 — Feature-first architecture with inward dependencies

**Status:** Accepted (PR-00, 2026-09-04)

## Context

Trilha's mobile client will grow to a dozen or more capabilities. The default Flutter
tutorial layout — global `models/`, `services/`, `widgets/`, `screens/` — spreads a
single capability across four directories and makes it impossible to see, delete, or
hand over a feature as a unit.

At the same time, a full ceremonial Clean Architecture applied to every screen produces
more interfaces than behaviour.

## Decision

Feature-first: each capability owns a vertical slice.

```
features/<feature>/
├── domain/        # entities and rules; pure Dart
├── application/   # use cases, state orchestration
├── data/          # repositories, DTOs, adapters
└── presentation/  # screens and widgets
```

Dependencies point inward: `presentation → application → domain`. `data` implements
ports declared inward. `domain` imports nothing from the other layers and no Flutter.

**Layers are created when they carry weight.** A feature with no rules does not get an
empty `domain/`. Directories are not architecture.

Cross-cutting technical capability lives in `core/` (networking, logging, errors,
observability); reusable presentation lives in `shared/`.

## Alternatives

- **Layer-first (global models/services/widgets).** Rejected: no capability is
  locatable or removable as a unit; unrelated features collide constantly.
- **Full Clean Architecture everywhere.** Rejected: mandatory interfaces, mappers and
  use-case classes per screen produce ceremony disproportionate to the domain
  (constitution: architecture proportional to the problem).
- **BLoC as the organising architecture.** Rejected for the same reason Riverpod is
  rejected as architecture in ADR-0005: a state-management library is a tool, not a
  structure.

## Consequences

- A feature can be reviewed, tested, and deleted as a unit.
- `domain` is testable with plain `dart test` — no widget pumping, no container.
- Some duplication across features is expected and accepted; premature extraction into
  `shared/` couples features that should stay independent.
- Discipline is required: the inward rule is enforced by review, since Dart has no
  compile-time module visibility across directories.
