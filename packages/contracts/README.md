# @trilha/contracts

Machine-readable contracts for the Trilha API.

## What lives here

| Path                    | Produced by                        | Status      |
| ----------------------- | ---------------------------------- | ----------- |
| `openapi/openapi.json`  | `npm run openapi:generate` in `apps/api` | Generated — do not hand-edit |

## Strategy

The API is the single source of truth. `openapi.json` is **generated from the running
NestJS metadata**, so it cannot drift from the code that serves the requests: a route
or response shape that changes without regenerating shows up as a diff in CI.

Deliberately **not** done yet (PR-00 builds foundations, not speculative tooling):

- No TypeScript ⇄ Dart class sharing. The two toolchains have different type systems,
  lifecycles and null semantics; sharing source across them creates coupling that is
  expensive to undo. The contract is the schema, not a shared class.
- No client code generation. Once endpoints with real payloads exist, a Dart client
  may be generated from this document — that decision belongs to the PR that first
  needs it (see `docs/adr/ADR-0006-api-contract-strategy.md`).

## Regenerating

```bash
cd apps/api
npm run build
npm run openapi:generate
```

Commit the result together with the change that caused it.
