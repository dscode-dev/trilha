import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../../../common/errors/app-error.js';
import { ErrorCode } from '../../../../common/errors/error-codes.js';
import { AppConfig } from '../../../../infrastructure/config/app-config.js';
import { RateLimiterService } from '../../../../infrastructure/rate-limit/rate-limiter.service.js';
import { clientIp } from '../../../identity/presentation/request-context.helper.js';
import type { AuthenticatedRequest } from '../../../identity/presentation/guards/authenticated-request.js';

/**
 * Rate limits discovery (§42).
 *
 * Stricter than routing, and on a longer window, because a discovery costs strictly
 * more than a route: it is a route calculation *plus* a travel-cost matrix. Reusing
 * the routing ceiling would let a client convert its routing budget into twice the
 * upstream spend without asking for anything different.
 *
 * The window is an hour rather than the shared short one. Discovery is an occasional
 * deliberate action — you plan a trip, you do not plan sixty in a minute — so a
 * per-minute ceiling would either be so high it bounds nothing or so low it punishes
 * someone adjusting a filter.
 *
 * Two buckets as elsewhere: the account spends the quota, the address stops a pool of
 * accounts from multiplying the bill. Neither key contains a coordinate (§53).
 */
@Injectable()
export class DiscoveryRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const limits = this.config.rateLimit;

    const userId = request.principal?.userId;
    if (userId !== undefined) {
      await this.enforce(`discovery:user:${userId}`, limits.discoveryPerUser);
    }

    await this.enforce(`discovery:ip:${clientIp(request) ?? 'unknown'}`, limits.discoveryPerIp);
    return true;
  }

  private async enforce(bucket: string, limit: number): Promise<void> {
    const decision = await this.limiter.consume(
      bucket,
      limit,
      this.config.rateLimit.discoveryWindowSeconds,
    );

    if (!decision.allowed) {
      throw new AppError({
        code: ErrorCode.TOO_MANY_REQUESTS,
        message: 'Too many discovery requests. Please wait before searching again.',
        httpStatus: HttpStatus.TOO_MANY_REQUESTS,
        details: { retryAfterSeconds: decision.retryAfterSeconds },
      });
    }
  }
}
