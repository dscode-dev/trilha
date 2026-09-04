import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';

/**
 * Owns the Redis connection lifecycle (§8).
 *
 * Constitution: Redis is never a source of truth. Losing it must therefore degrade
 * the service, not kill it — the process stays up, readiness turns red, and callers
 * of `ping()` learn the truth. No domain caching is introduced in PR-00.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;
  private readonly commandTimeoutMs: number;

  constructor(
    config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RedisService.name);
    this.commandTimeoutMs = config.redis.commandTimeoutMs;

    this.client = new Redis(config.redis.url, {
      /* Connect explicitly in onModuleInit so startup failures are observable. */
      lazyConnect: true,
      connectTimeout: config.redis.connectTimeoutMs,
      commandTimeout: config.redis.commandTimeoutMs,
      /* Fail commands fast while disconnected rather than queueing them forever. */
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });

    this.client.on('error', (error: Error) => {
      /* ioredis emits on every reconnect attempt; warn, never throw. */
      this.logger.warn({ event: 'redis.error', err: error }, 'Redis connection error');
    });
    this.client.on('ready', () => {
      this.logger.info({ event: 'redis.ready' }, 'Redis connection established');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      /* Boot proceeds: readiness will report Redis as down until it recovers. */
      this.logger.warn(
        { event: 'redis.connect.failed', err: error },
        'Redis unavailable at startup; continuing in degraded mode',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => {
      this.client.disconnect();
    });
    this.logger.info({ event: 'redis.disconnected' }, 'Redis connection closed');
  }

  /** Direct client access for modules that own a real caching concern. */
  get connection(): Redis {
    return this.client;
  }

  /**
   * Round-trips PING. Rejects when Redis is unreachable or slow — the timeout is
   * enforced here too, because a socket stuck in `connecting` never errors on its own.
   */
  async ping(): Promise<void> {
    await withTimeout(this.client.ping(), this.commandTimeoutMs, 'Redis PING timed out');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
