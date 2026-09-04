import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '../cache/redis.service.js';

/**
 * Distributed rate limiting backed by Redis (§26).
 *
 * Hand-rolled rather than delegated to `@nestjs/throttler@6.5.0`, which declares a
 * peer range of NestJS 7–11 and does not support NestJS 12 — the same situation as
 * `@sentry/nestjs` in PR-00, and forcing an unsupported peer is not a production
 * baseline. The whole mechanism is one Lua script, so the dependency was buying very
 * little.
 *
 * **Algorithm.** Fixed window: `INCR`, and set the TTL on the first hit of a window.
 * The script is atomic, so a counter can never be created without an expiry and keys
 * cannot accumulate. The known trade-off is boundary burst — a caller can spend a
 * full allowance at the end of one window and again at the start of the next, up to
 * 2× the limit across the seam. For authentication throttling that is acceptable:
 * the goal is to make credential stuffing expensive, not to meter precisely.
 *
 * Counters live only in Redis. Redis being unavailable does not block authentication
 * (see `consume`), because a cache outage must not become a total login outage.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the current window ends. */
  readonly retryAfterSeconds: number;
}

/**
 * `INCR` then set the expiry only when the counter was just created, so a long-lived
 * key cannot be left without a TTL. Returns the count and remaining TTL together to
 * avoid a second round trip.
 */
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

@Injectable()
export class RateLimiterService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RateLimiterService.name);
  }

  /**
   * Records one attempt against `bucket` and reports whether it is allowed.
   *
   * **Fails open.** If Redis is unreachable the attempt is permitted and the failure
   * is logged. Failing closed would turn a cache outage into an inability to sign in
   * for anyone, which is a worse outcome than a temporarily unthrottled window — and
   * the constitution already holds that losing Redis degrades rather than breaks the
   * service.
   */
  async consume(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const key = `ratelimit:${bucket}`;
    const windowMs = windowSeconds * 1_000;

    try {
      const raw = await this.redis.connection.eval(FIXED_WINDOW_SCRIPT, 1, key, String(windowMs));
      const [count, ttlMs] = parseScriptResult(raw);

      const remaining = Math.max(0, limit - count);
      return {
        allowed: count <= limit,
        limit,
        remaining,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1_000)),
      };
    } catch (error) {
      this.logger.warn(
        { event: 'ratelimit.unavailable', err: error },
        'Rate limiter unavailable; allowing request',
      );
      return { allowed: true, limit, remaining: limit, retryAfterSeconds: 0 };
    }
  }

  /**
   * Clears a bucket. Used after a successful login so that a user who mistyped a few
   * times is not still throttled once they get it right.
   */
  async reset(bucket: string): Promise<void> {
    try {
      await this.redis.connection.del(`ratelimit:${bucket}`);
    } catch (error) {
      this.logger.warn({ event: 'ratelimit.reset.failed', err: error }, 'Could not reset bucket');
    }
  }

  /**
   * Stable, non-reversible key component for a value that must not be stored in the
   * clear — an email address, in practice.
   *
   * Redis keys end up in `MONITOR` output, slow logs and memory dumps; putting raw
   * addresses there would leak the user base (§48, §59).
   */
  static hashIdentifier(value: string): string {
    return createHash('sha256').update(value.toLowerCase(), 'utf8').digest('hex').slice(0, 32);
  }
}

/** ioredis returns Lua tables as `unknown`; narrow before use. */
function parseScriptResult(raw: unknown): [count: number, ttlMs: number] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new TypeError('Unexpected rate limiter script result');
  }
  const count = Number(raw[0]);
  const ttl = Number(raw[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
    throw new TypeError('Non-numeric rate limiter script result');
  }
  /* PTTL returns -1 when the key has no expiry and -2 when it is gone; treat both as
     "window just started" rather than propagating a negative retry hint. */
  return [count, ttl < 0 ? 0 : ttl];
}
