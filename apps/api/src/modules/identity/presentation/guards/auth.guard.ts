import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { isSessionUsable } from '../../domain/user.js';
import { InvalidTokenError, SessionExpiredError } from '../../domain/identity-errors.js';
import { SessionRepository } from '../../infrastructure/session.repository.js';
import { TokenService } from '../../infrastructure/token.service.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

/**
 * Authenticates a request from its bearer token (§31).
 *
 * Two checks, both required:
 *   1. the JWT verifies — signature, expiry, issuer and audience;
 *   2. the session named by `sid` is still live.
 *
 * The second is what makes logout meaningful. Without it a revoked session's access
 * token would keep working for its full remaining lifetime, and "log out everywhere"
 * would be advisory. The cost is one indexed primary-key lookup per request.
 *
 * Authorization beyond "is this a valid session" is out of scope: PR-01 introduces no
 * roles, because nothing yet distinguishes one authenticated user's rights from
 * another's (§31).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = extractBearerToken(request.headers.authorization);
    if (token === undefined) throw new InvalidTokenError();

    const claims = await this.tokens.verifyAccessToken(token);

    const session = await this.sessions.findSession(claims.sid);
    if (session === undefined) throw new SessionExpiredError();
    if (!isSessionUsable(session, new Date())) throw new SessionExpiredError();

    /* A token whose subject disagrees with its session is malformed or forged. */
    if (session.userId !== claims.sub) throw new InvalidTokenError();

    request.principal = { userId: claims.sub, sessionId: claims.sid };
    return true;
  }
}

/** Parses `Authorization: Bearer <token>`, case-insensitively on the scheme. */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;

  const [scheme, value, ...rest] = header.trim().split(/\s+/);
  if (rest.length > 0) return undefined;
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  if (value === undefined || value.length === 0) return undefined;

  return value;
}
