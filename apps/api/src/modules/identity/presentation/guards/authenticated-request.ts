import type { Request } from 'express';

/** Identity attached to a request by [AuthGuard]. Minimal by design (§31). */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  principal?: AuthenticatedPrincipal;
}
