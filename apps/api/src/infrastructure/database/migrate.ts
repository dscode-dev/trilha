/**
 * Standalone migration runner (§6).
 *
 * Compiled into `dist` and executed with plain `node` in containers, so applying
 * migrations in production needs no TypeScript toolchain in the runtime image.
 *
 *   local : npm run db:migrate
 *   image : node dist/infrastructure/database/migrate.js
 */
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadAppConfig } from '../config/app-config.js';

/** Migrations live beside this file, both in `src` and in the compiled `dist`. */
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, 'migrations');

export async function runMigrations(): Promise<void> {
  const config = loadAppConfig(process.env);

  const pool = new Pool({
    connectionString: config.database.url,
    /* A migration run is short-lived and strictly serial. */
    max: 1,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
    ...(config.database.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

/* Only self-executes when invoked directly, so tests can import `runMigrations`. */
if (argv[1] !== undefined && import.meta.filename === resolve(argv[1])) {
  runMigrations()
    .then(() => {
      console.log(JSON.stringify({ event: 'database.migrations.applied', status: 'ok' }));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: 'database.migrations.failed',
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      /* Never continue past a failed migration (constitution §Engineering). */
      process.exit(1);
    });
}
