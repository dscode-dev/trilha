import { Injectable } from '@nestjs/common';
import { isSessionUsable } from '../domain/user.js';
import { InvalidTokenError, SessionExpiredError } from '../domain/identity-errors.js';
import { SessionRepository } from '../infrastructure/session.repository.js';
import { TokenService } from '../infrastructure/token.service.js';
import type { AuthenticatedPrincipal } from '../presentation/guards/authenticated-request.js';

/**
 * Identity's public surface for authenticating a request.
 *
 * This exists so other bounded contexts can require a session without importing
 * identity's internals. `AuthGuard` is instantiated inside whichever module declares
 * `@UseGuards(AuthGuard)`, so its dependencies must be resolvable there — exporting
 * `TokenService` and `SessionRepository` to satisfy that would hand every consumer
 * the ability to mint tokens and revoke sessions. Exporting one narrow service
 * instead keeps the boundary ADR-0001 depends on.
 *
 * It also puts the rule in a class that can be tested without an HTTP context.
 */
@Injectable()
export class SessionAuthenticator {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionRepository,
  ) {}

  /**
   * Resolves a bearer header to a principal.
   *
   * Two checks, both required: the JWT verifies (signature, expiry, issuer,
   * audience), and the session it names is still live. The second is what makes
   * logout meaningful — without it a revoked session's access token would keep
   * working for its full remaining lifetime.
   */
  async authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedPrincipal> {
    const token = extractBearerToken(authorizationHeader);
    if (token === undefined) throw new InvalidTokenError();

    const claims = await this.tokens.verifyAccessToken(token);

    const session = await this.sessions.findSession(claims.sid);
    if (session === undefined) throw new SessionExpiredError();
    if (!isSessionUsable(session, new Date())) throw new SessionExpiredError();

    /* A token whose subject disagrees with its session is malformed or forged. */
    if (session.userId !== claims.sub) throw new InvalidTokenError();

    return { userId: claims.sub, sessionId: claims.sid };
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
