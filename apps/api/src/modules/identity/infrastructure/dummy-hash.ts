import { hash } from '@node-rs/argon2';
import { ARGON2_PARAMETERS } from './password-hasher.js';

/**
 * A real Argon2id hash of an unguessable value, verified against when no account
 * matches a login attempt.
 *
 * Without it, "unknown email" would return in microseconds while "wrong password"
 * would take ~90 ms, and that difference alone is a reliable account-existence oracle
 * — which would defeat the identical error message required by §12/§27.
 *
 * Computed once at startup so the cost is not paid on the request path.
 */
let cachedDummyHash: Promise<string> | undefined;

export function getDummyHash(): Promise<string> {
  cachedDummyHash ??= hash(
    // Not a credential: nothing accepts this value, it exists only to be rejected.
    'trilha:timing-equaliser:6f4a1c9e-2b7d-4f3a-9c8e-1d5b7a3f0e62',
    ARGON2_PARAMETERS,
  );
  return cachedDummyHash;
}
