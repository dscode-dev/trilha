import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { SessionAuthenticator } from '../../application/session-authenticator.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

/**
 * Requires a live session (§31).
 *
 * The rule lives in [SessionAuthenticator]; this is the transport adapter for it.
 * Keeping the guard this thin is what lets other bounded contexts use it: it depends
 * on one exported service rather than on identity's token and session internals.
 *
 * Authorization beyond "is this a valid session" is out of scope — PR-01 introduced
 * no roles, because nothing yet distinguishes one authenticated user's rights from
 * another's.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authenticator: SessionAuthenticator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    request.principal = await this.authenticator.authenticate(request.headers.authorization);
    return true;
  }
}

export { extractBearerToken } from '../../application/session-authenticator.js';
