# ADR-0005 — Riverpod for composition, dependency injection and state

**Status:** Accepted (PR-00, 2026-09-04)

## Context

The Flutter client needs dependency composition (config, logger, HTTP client),
lifecycle management (dispose sockets with the scope that owns them), and reactive
state. It also needs to be testable without launching an app.

The risk is not choosing the wrong library — it is letting the library become the
architecture. A codebase where business rules live inside provider bodies is one where
rules cannot be tested or reused outside Riverpod, and where "where does this logic
live?" has no answer.

## Decision

**flutter_riverpod 3.4.3**, scoped deliberately:

> **Riverpod is a tool for composition, dependency injection and state.
> Riverpod is not our architecture.** (Constitution §7, §8; ADR-0002.)

Rules that follow from that:

1. **Providers wire; they do not decide.** Business rules live in a feature's
   `domain`/`application` layers as plain Dart, testable with no `ProviderContainer`.
2. **Providers own lifecycle.** Anything holding a resource registers `ref.onDispose`.
   The API client closes its sockets with its scope.
3. **No global provider by reflex.** A provider's scope matches its owner's lifetime;
   feature state is disposed with the feature.
4. **Composition-root values are injected, not read ambiently.** `AppConfig`,
   `AppLogger` and `ErrorReporter` are declared as providers that throw if unoverridden,
   and `bootstrap` supplies them. A missing override fails loudly at startup instead of
   silently returning a default — this is asserted by a test.

## Alternatives

- **BLoC.** Rejected: solves state well but not dependency composition, so a second DI
  mechanism (`get_it`/`provider`) would be needed alongside it. More ceremony per unit
  of behaviour.
- **`provider` alone.** Rejected: `BuildContext`-bound lookups are awkward to test and
  fail at runtime rather than compile time.
- **`get_it` service locator.** Rejected: dependencies become invisible in a
  constructor, and lifecycle is manual and easy to get wrong.
- **`setState` only.** Rejected: no answer for shared state or dependency composition.

## Consequences

- Compile-time-safe dependency access; overriding for tests is first-class.
- Automatic disposal removes a whole class of socket and subscription leaks.
- **The main risk is cultural, not technical**: Riverpod makes it easy to put logic in a
  provider. Review must reject that. The `features/README.md` layer rules and this ADR
  exist to make the expectation explicit and enforceable.
- Riverpod 3 wraps provider errors in `ProviderException`; error assertions in tests
  match on the underlying cause rather than the wrapper type.
