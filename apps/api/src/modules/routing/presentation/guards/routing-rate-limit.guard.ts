import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../../../common/errors/app-error.js';
import { ErrorCode } from '../../../../common/errors/error-codes.js';
import { AppConfig } from '../../../../infrastructure/config/app-config.js';
import { RateLimiterService } from '../../../../infrastructure/rate-limit/rate-limiter.service.js';
import { clientIp } from '../../../identity/presentation/request-context.helper.js';
import type { AuthenticatedRequest } from '../../../identity/presentation/guards/authenticated-request.js';

/**
 * Rate limits route calculation (§27).
 *
 * Routing differs from the auth endpoints in what it protects: every call spends real
 * money at a metered third party. The limit therefore exists to bound cost and abuse
 * rather than to slow credential guessing, and it gets its own ceilings instead of
 * reusing the login policy.
 *
 * Two buckets, both enforced: **per user**, because an authenticated account is the
 * unit that spends quota, and **per source address**, so a pool of accounts behind one
 * host cannot multiply the bill. Coordinates never form part of a key — that would
 * both explode cardinality and write journey data into Redis (§27, §58).
 */
@Injectable()
export class RoutingRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const limits = this.config.rateLimit;

    /* AuthGuard runs first, so a principal is present on every routing request. */
    const userId = request.principal?.userId;
    if (userId !== undefined) {
      await this.enforce(`routing:user:${userId}`, limits.routingPerUser);
    }

    await this.enforce(`routing:ip:${clientIp(request) ?? 'unknown'}`, limits.routingPerIp);
    return true;
  }

  private async enforce(bucket: string, limit: number): Promise<void> {
    const decision = await this.limiter.consume(bucket, limit, this.config.rateLimit.windowSeconds);

    if (!decision.allowed) {
      throw new AppError({
        code: ErrorCode.TOO_MANY_REQUESTS,
        message: 'Too many route requests. Please wait a moment and try again.',
        httpStatus: HttpStatus.TOO_MANY_REQUESTS,
        details: { retryAfterSeconds: decision.retryAfterSeconds },
      });
    }
  }
}
