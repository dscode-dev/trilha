import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';

/**
 * Schema guarantees, asserted against real PostgreSQL (§48, §93).
 *
 * Every rule here is also enforced in the application layer, which is where a caller
 * gets a useful error. These tests exist because the application is not the only thing
 * that can write to this database — a migration, a fix-up script or a future service
 * can too, and an invariant that lives only in TypeScript is an invariant one `UPDATE`
 * away from being false.
 */
describe('Trail schema (PostgreSQL)', () => {
  let app: INestApplication;
  let database: DatabaseService;

  const suite = `TrailSchema-${Math.random().toString(36).slice(2, 8)}`;
  let ownerId: string;
  let placeA: string;
  let placeB: string;

  const exec = async (statement: ReturnType<typeof sql>): Promise<void> => {
    await database.db.execute(statement);
  };

  /**
   * Runs a statement in its own transaction and returns the failure, if any.
   *
   * The whole error chain, not just the top message: Drizzle wraps the driver error in
   * a "Failed query" of its own, and the constraint name — the thing worth asserting —
   * lives on the cause underneath it.
   */
  const attempt = async (statement: ReturnType<typeof sql>): Promise<string | null> => {
    try {
      await database.db.transaction(async (tx) => {
        await tx.execute(statement);
      });
      return null;
    } catch (error) {
      const messages: string[] = [];
      let current: unknown = error;

      while (current instanceof Error) {
        messages.push(current.message);
        const withConstraint = current as Error & { constraint?: string };
        if (withConstraint.constraint !== undefined) messages.push(withConstraint.constraint);
        current = (current as Error & { cause?: unknown }).cause;
      }

      return messages.join(' | ');
    }
  };

  const newTrail = async (): Promise<string> => {
    const result = await database.db.execute<{ id: string }>(sql`
      INSERT INTO trails (owner_user_id, origin_location, destination_location, origin_label)
      VALUES (
        ${ownerId},
        ST_SetSRID(ST_MakePoint(-34.8711, -8.0631), 4326)::geography,
        ST_SetSRID(ST_MakePoint(-34.8631, -7.115), 4326)::geography,
        ${suite}
      )
      RETURNING id
    `);

    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('trail insert failed');
    return id;
  };

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    database = app.get(DatabaseService);

    const user = await database.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, status)
      VALUES (${`${suite}@example.test`}, 'ACTIVE')
      RETURNING id
    `);
    ownerId = user.rows[0]?.id ?? '';

    const seedPlace = async (name: string, latitude: number): Promise<string> => {
      const result = await database.db.execute<{ id: string }>(sql`
        INSERT INTO places (name, category_id, location, provenance, status)
        VALUES (${`${suite} ${name}`}, 'LANDMARK',
                ST_SetSRID(ST_MakePoint(-34.85, ${latitude}), 4326)::geography,
                'SYSTEM', 'ACTIVE')
        RETURNING id
      `);
      return result.rows[0]?.id ?? '';
    };

    placeA = await seedPlace('A', -7.9);
    placeB = await seedPlace('B', -7.6);
  }, 90_000);

  afterAll(async () => {
    await exec(sql`DELETE FROM trails WHERE origin_label = ${suite}`);
    await exec(sql`DELETE FROM places WHERE name LIKE ${`${suite}%`}`);
    await exec(sql`DELETE FROM users WHERE email = ${`${suite}@example.test`}`);
    await app.close();
  });

  describe('stop constraints (§33, §48)', () => {
    it('refuses the same Place twice on one trail', async () => {
      const trailId = await newTrail();
      await exec(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeA}, 1, 'DISCOVERY')
      `);

      const error = await attempt(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeA}, 2, 'SEARCH')
      `);

      expect(error).toMatch(/trail_stops_trail_place_unique/);
    });

    it('allows the same Place on two different trails', async () => {
      const first = await newTrail();
      const second = await newTrail();

      await exec(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${first}, ${placeA}, 1, 'SEARCH')
      `);
      const error = await attempt(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${second}, ${placeA}, 1, 'SEARCH')
      `);

      /* A Place is reusable across trails; that is the whole point of it being a
         separate concept (constitution §Domain). */
      expect(error).toBeNull();
    });

    it('refuses a position below 1', async () => {
      const trailId = await newTrail();

      const error = await attempt(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeA}, 0, 'MANUAL')
      `);

      expect(error).toMatch(/trail_stops_position_positive_check/);
    });

    it('refuses a stop pointing at no Place', async () => {
      const trailId = await newTrail();

      const error = await attempt(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, '0199f4c1-0000-7000-8000-0000000000ff', 1, 'MANUAL')
      `);

      /* A stop is always a resolved Place; an orphan is not a state the domain has. */
      expect(error).toMatch(/trail_stops_place_id_places_id_fk/);
    });

    it('refuses to delete a Place a trail still stops at (§50, §51)', async () => {
      const trailId = await newTrail();
      await exec(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeB}, 1, 'SEARCH')
      `);

      const error = await attempt(sql`DELETE FROM places WHERE id = ${placeB}`);

      /* A refused delete beats a mutilated Trail: removing a stop because the Place
         row went away would rewrite someone's composition without asking. */
      expect(error).toMatch(/trail_stops_place_id_places_id_fk/);

      await exec(sql`DELETE FROM trail_stops WHERE trail_id = ${trailId}`);
    });

    it('rejects non-contiguous positions at COMMIT (§48)', async () => {
      const trailId = await newTrail();

      const error = await attempt(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeA}, 1, 'SEARCH'), (${trailId}, ${placeB}, 3, 'SEARCH')
      `);

      expect(error).toMatch(/non-contiguous stop positions/);
    });

    it('permits a transient collision that is resolved before COMMIT', async () => {
      const trailId = await newTrail();
      await exec(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeA}, 1, 'SEARCH'), (${trailId}, ${placeB}, 2, 'SEARCH')
      `);

      /* The two-pass swap the repository performs: park every row above the occupied
         range, then bring them back reversed. Between the statements two rows would
         collide under any immediate constraint. */
      let failure: string | null = null;
      try {
        await database.db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE trail_stops SET position = position + 1000 WHERE trail_id = ${trailId}
          `);
          await tx.execute(sql`
            UPDATE trail_stops SET position = 1003 - position WHERE trail_id = ${trailId}
          `);
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }

      /* Deferring the check is what makes a legitimate reorder possible: it necessarily
         passes through states no row-level constraint would accept. */
      expect(failure).toBeNull();

      const positions = await database.db.execute<{ position: number }>(sql`
        SELECT position FROM trail_stops WHERE trail_id = ${trailId} ORDER BY position
      `);
      expect(positions.rows.map((r) => r.position)).toEqual([1, 2]);
    });

    it('removes stops when the trail goes (§50)', async () => {
      const trailId = await newTrail();
      await exec(sql`
        INSERT INTO trail_stops (trail_id, place_id, position, source)
        VALUES (${trailId}, ${placeA}, 1, 'SEARCH')
      `);

      await exec(sql`DELETE FROM trails WHERE id = ${trailId}`);

      const rows = await database.db.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM trail_stops WHERE trail_id = ${trailId}`,
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });
  });

  describe('trail constraints (§48)', () => {
    it('refuses a revision below 1', async () => {
      const trailId = await newTrail();

      expect(await attempt(sql`UPDATE trails SET revision = 0 WHERE id = ${trailId}`)).toMatch(
        /trails_revision_positive_check/,
      );
    });

    it('refuses a snapshot claiming a revision that has not happened', async () => {
      const trailId = await newTrail();

      const error = await attempt(sql`
        UPDATE trails
           SET route_geometry = ST_GeomFromText('LINESTRING(-34.87 -8.06, -34.86 -7.11)', 4326),
               route_distance_meters = 1, route_duration_seconds = 1,
               route_calculated_at = now(), route_revision = 99
         WHERE id = ${trailId}
      `);

      expect(error).toMatch(/trails_route_revision_range_check/);
    });

    it('refuses half a snapshot', async () => {
      const trailId = await newTrail();

      const error = await attempt(sql`
        UPDATE trails SET route_distance_meters = 1000 WHERE id = ${trailId}
      `);

      /* A distance with no line, or a line with no distance, would let a screen render
         one without the other. */
      expect(error).toMatch(/trails_route_snapshot_complete_check/);
    });

    it('refuses a degenerate route geometry', async () => {
      const trailId = await newTrail();

      const error = await attempt(sql`
        UPDATE trails
           SET route_geometry = ST_GeomFromText('LINESTRING(-34.87 -8.06)', 4326),
               route_distance_meters = 1, route_duration_seconds = 1,
               route_calculated_at = now(), route_revision = 1
         WHERE id = ${trailId}
      `);

      /* PostGIS accepts a one-position LineString; the schema does not (ADR-0013). */
      expect(error).toBeTruthy();
    });

    it('refuses a negative metric', async () => {
      const trailId = await newTrail();

      expect(
        await attempt(sql`UPDATE trails SET base_distance_meters = -1 WHERE id = ${trailId}`),
      ).toMatch(/trails_route_metrics_non_negative_check/);
    });

    it('keeps finalized_at and status in agreement', async () => {
      const trailId = await newTrail();

      expect(
        await attempt(sql`UPDATE trails SET status = 'FINALIZED' WHERE id = ${trailId}`),
      ).toMatch(/trails_finalized_at_matches_status_check/);

      expect(
        await attempt(sql`UPDATE trails SET finalized_at = now() WHERE id = ${trailId}`),
      ).toMatch(/trails_finalized_at_matches_status_check/);
    });

    it('refuses a trail with no owner', async () => {
      const error = await attempt(sql`
        INSERT INTO trails (owner_user_id, origin_location, destination_location)
        VALUES (
          '0199f4c1-0000-7000-8000-0000000000ff',
          ST_SetSRID(ST_MakePoint(-34.87, -8.06), 4326)::geography,
          ST_SetSRID(ST_MakePoint(-34.86, -7.11), 4326)::geography
        )
      `);

      expect(error).toMatch(/trails_owner_user_id_users_id_fk/);
    });

    it('has no publication column (§72, §108)', async () => {
      const columns = await database.db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trails'
      `);
      const names = columns.rows.map((r) => r.column_name);

      for (const forbidden of ['is_public', 'slug', 'share_count', 'comment_count', 'rating']) {
        expect(names).not.toContain(forbidden);
      }
    });

    it('has no route history or event table (§19, §47)', async () => {
      const tables = await database.db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `);
      const names = tables.rows.map((r) => r.table_name);

      expect(names).toContain('trails');
      expect(names).toContain('trail_stops');
      /* One current snapshot per trail, not a movement history (§19). */
      expect(names).not.toContain('trail_versions');
      expect(names).not.toContain('trail_route_history');
      expect(names).not.toContain('trail_events');
    });
  });

  describe('indexes (§49)', () => {
    it('indexes the listing query and the stop read', async () => {
      const indexes = await database.db.execute<{ indexname: string }>(sql`
        SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename IN ('trails', 'trail_stops')
      `);
      const names = indexes.rows.map((r) => r.indexname);

      expect(names).toContain('trails_owner_updated_idx');
      expect(names).toContain('trail_stops_trail_position_idx');
      expect(names).toContain('trail_stops_trail_place_unique');
    });
  });
});
