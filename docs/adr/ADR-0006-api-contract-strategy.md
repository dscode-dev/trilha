# ADR-0006 — Generated OpenAPI as the API contract

**Status:** Accepted (PR-00, 2026-09-04)

## Context

A TypeScript backend and a Dart client must agree on request and response shapes. The
two toolchains have different type systems, null semantics, build pipelines and release
cadences, so there is no shared language in which to express the contract natively.

The failure mode to avoid is a contract that drifts: documentation that describes what
the API used to do.

## Decision

**The API implementation is the source of truth. The contract is generated from it.**

- `@nestjs/swagger` derives an OpenAPI 3 document from live Nest metadata.
- `npm run openapi:generate` writes it to `packages/contracts/openapi/openapi.json`,
  which is committed. A shape change that is not regenerated shows up as a CI diff.
- The Swagger UI is served only when `SWAGGER_ENABLED=true` — off by default, so
  production does not publish its own surface unless deliberately enabled.
- Integration tests assert the document's shape: both platform routes present, readiness
  documented as able to return 503, the shared error envelope published, and **no
  product-domain paths**, which enforces the PR-00 scope freeze mechanically.

**Deliberately deferred:**

- **No Dart client generation yet.** With two platform endpoints, generated client code
  would cost more than the hand-written call it replaces. Revisit in the PR that first
  introduces endpoints with real payloads.
- **No shared TypeScript/Dart source.** Sharing classes across the two toolchains
  couples their build systems for a benefit a schema already provides.

## Alternatives

- **Hand-written OpenAPI.** Rejected: a second artefact to maintain, and it drifts —
  the failure mode this decision exists to prevent.
- **GraphQL.** Rejected: the frozen V1 stack is REST (PR-00 §2). GraphQL's schema-first
  contract is real, but adopting it for the contract alone would be tail-wagging-dog.
- **Generate Dart models now.** Rejected as premature: codegen complexity ahead of need.
- **No contract artefact.** Rejected: the mobile client would encode assumptions about
  response shapes with nothing to verify them against.

## Consequences

- The published contract cannot silently drift from the implementation.
- `packages/contracts/openapi/openapi.json` is a generated artefact: never hand-edited,
  and regenerated in the same commit as the change that alters it.
- Nest decorators (`@ApiProperty`) must be maintained on response DTOs; an undecorated
  field is missing from the contract. This is the maintenance cost accepted here.
- When a Dart client is generated later, this document is already the input.
