import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { InvalidTokenError } from '../../domain/identity-errors.js';
import type { AuthenticatedPrincipal, AuthenticatedRequest } from './authenticated-request.js';

/**
 * Injects the authenticated principal into a handler.
 *
 * Throws rather than returning `undefined` when no principal is present: reaching this
 * decorator without [AuthGuard] having run is a wiring mistake, and failing closed
 * means such a mistake cannot become an unauthenticated read.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.principal === undefined) throw new InvalidTokenError();
    return request.principal;
  },
);
