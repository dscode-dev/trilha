import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { RedisService } from '../../infrastructure/cache/redis.service.js';
import { DependencyStatus, type DependencyHealth } from './health.contract.js';

/**
 * Probes every dependency the API needs in order to serve real traffic (§10, §44).
 *
 * Readiness is only "ready" when all probes succeed — a probe that cannot fail is
 * not a probe. Probes run concurrently so one slow dependency does not serialise
 * the whole check.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReadinessService.name);
  }

  async check(): Promise<{ ready: boolean; dependencies: Record<string, DependencyHealth> }> {
    const [postgres, redis] = await Promise.all([
      this.probe('postgres', () => this.database.ping()),
      this.probe('redis', () => this.redis.ping()),
    ]);

    const dependencies = { postgres, redis };
    const ready = Object.values(dependencies).every((d) => d.status === DependencyStatus.UP);

    return { ready, dependencies };
  }

  private async probe(name: string, fn: () => Promise<unknown>): Promise<DependencyHealth> {
    const startedAt = performance.now();
    try {
      await fn();
      return { status: DependencyStatus.UP, durationMs: elapsed(startedAt) };
    } catch (error) {
      /* The unabridged failure belongs in the log, where operators can see it and
         clients cannot. Only the sanitised form goes on the wire. */
      this.logger.warn(
        { event: 'readiness.probe.failed', dependency: name, err: error },
        `Readiness probe failed for ${name}`,
      );

      return {
        status: DependencyStatus.DOWN,
        durationMs: elapsed(startedAt),
        reason: sanitiseReason(error),
      };
    }
  }
}

function elapsed(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

const MAX_REASON_LENGTH = 200;

/**
 * Reduces a driver error to something safe to put on the wire.
 *
 * Readiness is reachable by anything that can call the API, so its reasons must not
 * carry connection strings or SQL (constitution §Engineering, §11). The full error is
 * logged instead.
 */
export function sanitiseReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Unknown error';

  return (
    raw
      /* Credentialed DSNs: postgresql://user:pw@host/db, redis://… */
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[redacted-url]')
      /* Drizzle/pg append the failing statement and its parameters. */
      .replace(/Failed query:[\s\S]*/i, '[redacted-query]')
      .replace(/\bparams:[\s\S]*/i, '[redacted-params]')
      /* Any bare SQL statement that reached the message another way. */
      .replace(
        /\b(select|insert|update|delete|drop|alter|create|truncate)\b[\s\S]*/i,
        '[redacted-query]',
      )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_REASON_LENGTH)
  );
}
