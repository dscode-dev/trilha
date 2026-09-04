# ADR-0007 — ESM modules, TypeScript 6 and Vitest for the API

**Status:** Accepted (PR-00, 2026-09-04)

## Context

Constitution §25 requires latest stable versions, verified upstream at implementation
time. Doing that verification surfaced two facts that force real decisions rather than
defaults.

**1. NestJS 12 is ESM-only.** `@nestjs/common@12.0.1` declares `"type": "module"` and
ships no CommonJS build. A CommonJS application can still load it on Node ≥ 22.12 via
`require(esm)`, but that is a compatibility shim, not the supported path — and Jest's
sandboxed runtime does not implement it at all.

**2. TypeScript 7.0.2 is the latest stable, and the ecosystem cannot use it yet.**
Verified against the registry:

| Package                   | Version | Declared TypeScript peer |
| ------------------------- | ------- | ------------------------ |
| `typescript-eslint`       | 8.69.0  | `>=4.8.4 <6.1.0`         |
| `ts-jest`                 | 29.4.12 | `>=4.3 <7`               |

Two independent, actively maintained tools exclude TypeScript 7. Adopting it would mean
either abandoning type-aware linting (a required quality gate, PR-00 §26) or forcing an
unsupported peer range — neither of which is a production-grade baseline.

TypeScript 7 was verified as otherwise viable: a decorator-metadata test confirmed it
emits `design:paramtypes` correctly, so the blocker is purely ecosystem support.

## Decision

**The API is an ESM package** (`"type": "module"`, `module`/`moduleResolution: nodenext`,
explicit `.js` extensions on relative imports), matching the framework it is built on.

**TypeScript 6.0.3** — the highest stable release inside every tool's supported range.
(The npm `beta` dist-tag still points at `6.0.0-beta`; 6.0.2 and 6.0.3 are stable
releases and 6.0.3 is not deprecated.)

**Vitest 5.0.0** replaces Jest as the test runner, with `unplugin-swc` performing the
TypeScript transform because Vitest's default esbuild transform cannot emit
`emitDecoratorMetadata`, which Nest's DI requires.

Two consequences of ESM are handled explicitly: `import.meta.dirname` replaces
`__dirname`, and an `import.meta.filename` comparison replaces `require.main === module`.

Because esbuild-based runners cannot emit decorator metadata, `db:migrate` and
`openapi:generate` run from compiled `dist/` output — the same artefact the container
runs — rather than through a TypeScript loader.

## Alternatives

- **TypeScript 7 + no type-aware lint.** Rejected: removes a required quality gate to
  gain a version number.
- **TypeScript 7 + forced peer overrides.** Rejected: `typescript-eslint`'s parser
  consumes the TypeScript compiler API directly, which changed substantially in the
  native port. Overriding the declared range invites silent, hard-to-diagnose failures.
- **Stay on CommonJS and rely on `require(esm)`.** Rejected: works at runtime on Node
  ≥ 22.12 but is a shim, breaks under Jest, and leaves the application's module system
  permanently mismatched with its framework.
- **Keep Jest with `--experimental-vm-modules`.** Rejected: Jest's ESM support is
  experimental and its interaction with decorator metadata is fragile. Vitest handles
  ESM natively.
- **TypeScript 5.9.3.** Rejected: 6.0.3 is stable, supported by the whole toolchain, and
  closer to the constitution's default.

## Consequences

- The application's module system matches its framework; no interop shim on the
  critical path.
- Type-aware linting, formatting, typechecking and testing all work on supported,
  in-range versions. Zero warnings across the gates.
- **Upgrade trigger:** move to TypeScript 7 when `typescript-eslint` ships a stable
  release declaring a TS 7 peer range. Tracked as `TECHNICAL_DEBT`; recheck at each
  dependency review. This is the exception constitution §25 anticipates — latest stable
  applies per-package, and a package is not adoptable while its required tooling
  excludes it.
- Relative imports carry explicit `.js` extensions. This is required by `nodenext` and
  is enforced by the compiler, not by convention.
