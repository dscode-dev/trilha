import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { AppError } from '../../../../common/errors/app-error.js';
import { ErrorCode } from '../../../../common/errors/error-codes.js';
import { AppConfig } from '../../../../infrastructure/config/app-config.js';
import { RateLimiterService } from '../../../../infrastructure/rate-limit/rate-limiter.service.js';
import { clientIp } from '../../../identity/presentation/request-context.helper.js';
import type { AuthenticatedRequest } from '../../../identity/presentation/guards/authenticated-request.js';

/**
 * Rate limits Trail mutations (§54).
 *
 * Every composition change costs a routing call, and some cost two. The specific abuse
 * this bounds is cheap to perform and expensive to absorb: dragging a stop back and
 * forth is one gesture per provider request, and a client with a stuck retry loop
 * would do it as fast as the network allows.
 *
 * Reads are deliberately not limited here. `GET /trails` and `GET /trails/:id` are
 * served entirely from Trilha's own database and cost nothing upstream, so limiting
 * them would only punish a builder screen that refreshes.
 */
@Injectable()
export class TrailMutationRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const limits = this.config.rateLimit;

    const userId = request.principal?.userId;
    if (userId !== undefined) {
      await this.enforce(`trail:user:${userId}`, limits.trailMutationsPerUser);
    }

    await this.enforce(`trail:ip:${clientIp(request) ?? 'unknown'}`, limits.trailMutationsPerIp);
    return true;
  }

  private async enforce(bucket: string, limit: number): Promise<void> {
    const decision = await this.limiter.consume(
      bucket,
      limit,
      this.config.rateLimit.trailWindowSeconds,
    );

    if (!decision.allowed) {
      throw new AppError({
        code: ErrorCode.TOO_MANY_REQUESTS,
        message: 'Too many trail changes in a short time. Please wait a moment.',
        httpStatus: HttpStatus.TOO_MANY_REQUESTS,
        details: { retryAfterSeconds: decision.retryAfterSeconds },
      });
    }
  }
}
