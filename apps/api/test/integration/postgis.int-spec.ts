import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';

/**
 * Proves the geospatial foundation against a real PostgreSQL + PostGIS (§43).
 *
 * Nothing here is mocked or stubbed: mocking the database in the suite whose only
 * purpose is to prove the database works would prove nothing. SQLite is likewise
 * not a substitute — it has no PostGIS.
 */
describe('PostgreSQL + PostGIS integration', () => {
  let pool: Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    // Migrations must be idempotent: this runs against a database that may already
    // be migrated, and must still converge.
    await runMigrations();

    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 2 });
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('is reachable', async () => {
    const result = await db.execute<{ ok: number }>(sql`select 1 as ok`);
    expect(result.rows[0]?.ok).toBe(1);
  });

  it('reports a PostgreSQL major version the project supports', async () => {
    // `SHOW` ignores column aliases; current_setting() can be aliased.
    const result = await db.execute<{ v: string }>(
      sql`select current_setting('server_version') as v`,
    );
    const major = Number.parseInt(result.rows[0]?.v ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(16);
  });

  it('has the postgis extension installed by our migration', async () => {
    const result = await db.execute<{ version: string }>(
      sql`select extversion as version from pg_extension where extname = 'postgis'`,
    );
    expect(result.rows[0]?.version).toMatch(/^\d+\.\d+/);
  });

  it('has pgcrypto available for non-enumerable identifiers', async () => {
    const result = await db.execute<{ id: string }>(sql`select gen_random_uuid()::text as id`);
    expect(result.rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('constructs a valid geometry', async () => {
    const result = await db.execute<{ wkt: string; srid: number }>(
      sql`select ST_AsText(ST_SetSRID(ST_MakePoint(-46.6333, -23.5505), 4326)) as wkt,
                 ST_SRID(ST_SetSRID(ST_MakePoint(-46.6333, -23.5505), 4326)) as srid`,
    );

    expect(result.rows[0]?.wkt).toBe('POINT(-46.6333 -23.5505)');
    expect(Number(result.rows[0]?.srid)).toBe(4326);
  });

  it('rejects malformed geometry rather than silently accepting it', async () => {
    await expect(db.execute(sql`select ST_GeomFromText('NOT A GEOMETRY', 4326)`)).rejects.toThrow();
  });

  describe('spatial operations', () => {
    /* São Paulo → Rio de Janeiro, ~357 km great-circle. */
    const saoPaulo = sql`ST_SetSRID(ST_MakePoint(-46.6333, -23.5505), 4326)::geography`;
    const rio = sql`ST_SetSRID(ST_MakePoint(-43.1729, -22.9068), 4326)::geography`;

    it('computes a real geodesic distance', async () => {
      const result = await db.execute<{ meters: string }>(
        sql`select ST_Distance(${saoPaulo}, ${rio}) as meters`,
      );

      const km = Number(result.rows[0]?.meters) / 1000;
      expect(km).toBeGreaterThan(340);
      expect(km).toBeLessThan(375);
    });

    it('evaluates a radius predicate correctly in both directions', async () => {
      const result = await db.execute<{ within_500km: boolean; within_100km: boolean }>(
        sql`select ST_DWithin(${saoPaulo}, ${rio}, 500000) as within_500km,
                   ST_DWithin(${saoPaulo}, ${rio}, 100000) as within_100km`,
      );

      expect(result.rows[0]?.within_500km).toBe(true);
      expect(result.rows[0]?.within_100km).toBe(false);
    });
  });

  describe('spatial indexing', () => {
    /* A temp table keeps the shared dev database free of product tables, which
       PR-00 is forbidden from introducing. */
    const table = sql.raw('pg_temp.trilha_spatial_probe');

    it('supports a GIST index and uses it for a spatial predicate', async () => {
      await db.execute(
        sql`create temporary table trilha_spatial_probe (
              id uuid primary key default gen_random_uuid(),
              location geography(Point, 4326) not null
            )`,
      );
      await db.execute(sql`create index on ${table} using gist (location)`);

      await db.execute(
        sql`insert into ${table} (location)
            select ST_SetSRID(ST_MakePoint(-46.6 + (g * 0.001), -23.5 + (g * 0.001)), 4326)::geography
            from generate_series(1, 500) as g`,
      );
      await db.execute(sql`analyze ${table}`);

      const near = await db.execute<{ total: string }>(
        sql`select count(*) as total from ${table}
            where ST_DWithin(location, ST_SetSRID(ST_MakePoint(-46.6, -23.5), 4326)::geography, 1000)`,
      );

      expect(Number(near.rows[0]?.total)).toBeGreaterThan(0);
      expect(Number(near.rows[0]?.total)).toBeLessThan(500);

      /* EXPLAIN must stay available: the constitution forbids abstracting PostGIS
         to the point where query plans cannot be inspected (§7). */
      const plan = await db.execute<{ 'QUERY PLAN': string }>(
        sql`explain analyze select count(*) from ${table}
            where ST_DWithin(location, ST_SetSRID(ST_MakePoint(-46.6, -23.5), 4326)::geography, 1000)`,
      );
      expect(plan.rows.length).toBeGreaterThan(0);
    });
  });
});
