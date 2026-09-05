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

  /* --- Routing (PR-03) --- */
  /** The request was well-formed but no route connects the two points. */
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  /** Degenerate or implausible endpoints; rejected before any provider call. */
  INVALID_ROUTE_REQUEST: 'INVALID_ROUTE_REQUEST',
  /** An upstream routing provider exceeded its deadline. */
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  /** An upstream provider is unreachable or returned something unusable. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** Trilha's own quota with an upstream provider is exhausted. */
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',

  /* --- Trails (PR-05) --- */
  /** The trail changed between the client reading it and writing to it (§25). */
  TRAIL_REVISION_CONFLICT: 'TRAIL_REVISION_CONFLICT',
  TRAIL_STOP_LIMIT_REACHED: 'TRAIL_STOP_LIMIT_REACHED',
  TRAIL_STOP_DUPLICATE: 'TRAIL_STOP_DUPLICATE',
  INVALID_TRAIL_STOP_ORDER: 'INVALID_TRAIL_STOP_ORDER',
  /** The stored route no longer describes the current composition (§22). */
  TRAIL_ROUTE_STALE: 'TRAIL_ROUTE_STALE',
  TRAIL_STOP_PLACE_UNAVAILABLE: 'TRAIL_STOP_PLACE_UNAVAILABLE',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
