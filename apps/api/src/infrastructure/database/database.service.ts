import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';

/**
 * Owns the PostgreSQL connection pool and exposes the Drizzle query interface.
 *
 * Constitution: PostgreSQL is the transactional source of truth and PostGIS is
 * central infrastructure, so `sql` is deliberately re-exported as a first-class
 * escape hatch — spatial work must never be blocked by the ORM (ADR-0004).
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  readonly db: NodePgDatabase;

  constructor(
    config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DatabaseService.name);

    this.pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      connectionTimeoutMillis: config.database.connectTimeoutMs,
      /* Bounds runaway queries so one bad statement cannot exhaust the pool. */
      statement_timeout: config.database.statementTimeoutMs,
      ...(config.database.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    });

    /* An idle client erroring out must not take the process down. */
    this.pool.on('error', (error) => {
      this.logger.error({ event: 'database.pool.error', err: error }, 'Idle client error');
    });

    this.db = drizzle(this.pool);
  }

  async onModuleInit(): Promise<void> {
    /* Verify connectivity at boot so a misconfigured DSN fails the deploy, not the
       first user request. */
    await this.ping();
    this.logger.info({ event: 'database.connected' }, 'Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    this.logger.info({ event: 'database.disconnected' }, 'Database pool closed');
  }

  /** Round-trips a trivial query. Throws when the database is unreachable. */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  /** Reports the installed PostGIS version, or `null` when the extension is absent. */
  async postgisVersion(): Promise<string | null> {
    const result = await this.db.execute<{ version: string | null }>(
      sql`select extversion as version from pg_extension where extname = 'postgis'`,
    );
    return result.rows[0]?.version ?? null;
  }
}
