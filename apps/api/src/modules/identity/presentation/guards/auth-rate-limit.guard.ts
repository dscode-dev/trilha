import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../../../common/errors/app-error.js';
import { ErrorCode } from '../../../../common/errors/error-codes.js';
import { AppConfig } from '../../../../infrastructure/config/app-config.js';
import { RateLimiterService } from '../../../../infrastructure/rate-limit/rate-limiter.service.js';
import { clientIp } from '../request-context.helper.js';
import type { AuthenticatedRequest } from './authenticated-request.js';

/** 429 carrying the wait, so a client can back off instead of hammering. */
export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super({
      code: ErrorCode.TOO_MANY_REQUESTS,
      message: 'Too many attempts. Please wait a moment and try again.',
      httpStatus: HttpStatus.TOO_MANY_REQUESTS,
      details: { retryAfterSeconds },
    });
  }
}

/**
 * Rate limits the authentication endpoints (§26).
 *
 * **Key strategy.** Login is limited on two independent buckets:
 *
 *   - per source address — the ceiling on credential stuffing from one origin;
 *   - per *address + account* — a tighter ceiling on guessing one specific account.
 *
 * Deliberately **not** per-account alone. A global per-account counter would let
 * anyone lock any user out of their own account by burning the allowance from
 * elsewhere, converting a defence into a denial-of-service tool — the trap §26 names.
 * Pairing the account with the source keeps the attacker limited without letting them
 * reach past their own origin.
 *
 * The account component is hashed, never stored in the clear: Redis keys surface in
 * `MONITOR`, slow logs and memory dumps (§48).
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const route = request.path.split('/').pop() ?? '';
    const limits = this.config.rateLimit;
    const ip = clientIp(request) ?? 'unknown';

    switch (route) {
      case 'login':
        await this.enforce(`login:ip:${ip}`, limits.loginPerIp);
        await this.enforce(`login:acct:${ip}:${accountHint(request)}`, limits.loginPerAccount);
        return true;

      case 'register':
        await this.enforce(`register:ip:${ip}`, limits.registerPerIp);
        return true;

      case 'refresh':
        await this.enforce(`refresh:ip:${ip}`, limits.refreshPerIp);
        return true;

      default:
        /* logout and logout-all are authenticated and idempotent; throttling them
           would only get in the way of a user trying to secure their account. */
        return true;
    }
  }

  private async enforce(bucket: string, limit: number): Promise<void> {
    const decision = await this.limiter.consume(bucket, limit, this.config.rateLimit.windowSeconds);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);
  }
}

/**
 * Stable, non-reversible component identifying the targeted account.
 *
 * Reads the body defensively: the guard runs before validation, so the payload may be
 * anything at all.
 */
function accountHint(request: AuthenticatedRequest): string {
  const body: unknown = request.body;
  if (typeof body === 'object' && body !== null && 'email' in body) {
    const { email } = body;
    if (typeof email === 'string' && email.length > 0) {
      return RateLimiterService.hashIdentifier(email.trim());
    }
  }
  return 'anonymous';
}
