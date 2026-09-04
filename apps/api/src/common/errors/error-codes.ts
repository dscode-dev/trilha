/**
 * Machine-readable error codes returned to clients.
 *
 * These are part of the API contract: clients may branch on them, so a code is
 * never renamed or repurposed once shipped — only added or deprecated.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  /* --- Identity & session (PR-01) --- */
  /** Login failed. Deliberately identical for unknown account and wrong password (§27). */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_IN_USE: 'EMAIL_ALREADY_IN_USE',
  USERNAME_ALREADY_IN_USE: 'USERNAME_ALREADY_IN_USE',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  /** Access token missing, malformed, expired, or issued for another audience. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** The session behind a refresh token is revoked, expired, or gone. */
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  /** Account exists but is not permitted to authenticate. */
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
