import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only *generates* SQL; it never mutates a live schema.
 * Constitution §Engineering: no automatic schema mutation in production.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/database/schema/*.ts',
  out: './src/infrastructure/database/migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
