import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { httpServer } from '../support/http.js';
import { clearRateLimits, registerAccount, type AuthTokens } from '../support/identity.js';
import { LANDMARKS, contributor, createPlace, uniquePlaceName } from '../support/places.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/** Creating and reading Places (§23, §24, §33, §59). */
describe('Places — create and read', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let tokens: AuthTokens;
  let suite: string;

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    await clearRateLimits(app);
    database = app.get(DatabaseService);
    tokens = await contributor(app);
    suite = uniquePlaceName('CrudSuite');
  }, 60_000);

  afterAll(async () => {
    await database.db.execute(sql`DELETE FROM places WHERE name LIKE ${`${suite}%`}`);
    await app.close();
  });

  const post = (body: Record<string, unknown>, auth = true) => {
    const req = request(httpServer(app)).post('/api/v1/places');
    if (auth) req.set('Authorization', `Bearer ${tokens.accessToken}`);
    return req.send(body);
  };

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    name: `${suite} ${Math.random().toString(36).slice(2, 8)}`,
    categoryId: 'LANDMARK',
    latitude: LANDMARKS.marcoZero.latitude,
    longitude: LANDMARKS.marcoZero.longitude,
    ...overrides,
  });

  describe('POST /places (§24)', () => {
    it('creates a place and returns its detail', async () => {
      const response = await post(validBody({ description: 'A landmark.' })).expect(201);
      const body = response.body as { place: Record<string, unknown> };

      expect(body.place['id']).toEqual(expect.any(String));
      expect(body.place['description']).toBe('A landmark.');
      expect(body.place['latitude']).toBeCloseTo(LANDMARKS.marcoZero.latitude, 6);
    });

    it('sets provenance and status on the server, not from the request', async () => {
      /* A client claiming SYSTEM provenance or ARCHIVED status must be ignored:
         neither field is ever read from the body. */
      const response = await post(
        validBody({ provenance: 'SYSTEM', status: 'ARCHIVED', createdByUserId: 'someone-else' }),
      ).expect(201);

      const place = (response.body as { place: Record<string, unknown> }).place;
      expect(place['provenance']).toBe('COMMUNITY');
      expect(place['status']).toBe('ACTIVE');
    });

    it('attributes the place to the authenticated contributor', async () => {
      const response = await post(validBody()).expect(201);
      const place = (response.body as { place: { contributor: { username: string } | null } })
        .place;

      const me = await request(httpServer(app))
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(place.contributor?.username).toBe(
        (me.body as { profile: { username: string } }).profile.username,
      );
    });

    it('records the contributor id in the row', async () => {
      const created = await post(validBody()).expect(201);
      const id = (created.body as { place: { id: string } }).place.id;

      const row = await database.db.execute<{ created_by_user_id: string | null }>(
        sql`SELECT created_by_user_id FROM places WHERE id = ${id}`,
      );

      expect(row.rows[0]?.created_by_user_id).not.toBeNull();
    });

    it('normalises whitespace in the name (§14)', async () => {
      const messy = `${suite}   spaced    out`;
      const response = await post(validBody({ name: messy })).expect(201);

      expect((response.body as { place: { name: string } }).place.name).toBe(`${suite} spaced out`);
    });

    it('stores plain text, leaving markup unexecuted and unescaped', async () => {
      /* Trilha stores text, not HTML: nothing is stripped here, and the client
         escapes at render time. What matters is that the value round-trips exactly. */
      const withMarkup = `${suite} <b>Bold</b>`;
      const response = await post(validBody({ name: withMarkup })).expect(201);

      expect((response.body as { place: { name: string } }).place.name).toBe(withMarkup);
    });

    describe('rejects', () => {
      it.each([
        ['latitude above 90', { latitude: 91 }],
        ['latitude below -90', { latitude: -91 }],
        ['longitude above 180', { longitude: 181 }],
        ['longitude below -180', { longitude: -181 }],
        ['a NaN latitude', { latitude: 'NaN' }],
        ['an Infinity latitude', { latitude: 'Infinity' }],
        ['a null latitude', { latitude: null }],
        ['an empty-string latitude', { latitude: '' }],
        ['a missing latitude', { latitude: undefined }],
        ['a non-numeric latitude', { latitude: 'abc' }],
      ])('%s', async (_name, overrides) => {
        const response = await post(validBody(overrides)).expect(400);
        expect((response.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
      });

      it('an unknown category', async () => {
        const response = await post(validBody({ categoryId: 'NOT_A_CATEGORY' })).expect(400);
        expect((response.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
      });

      it.each([
        ['an empty name', { name: '' }],
        ['a whitespace-only name', { name: '   ' }],
        ['an over-long name', { name: 'x'.repeat(200) }],
        ['an over-long description', { description: 'x'.repeat(2000) }],
      ])('%s', async (_name, overrides) => {
        await post(validBody(overrides)).expect(400);
      });
    });

    /**
     * A latitude of 91 must never reach storage. PostGIS would coerce it to 89
     * rather than reject it, so a validation gap here is silent data corruption.
     */
    it('never persists an out-of-range coordinate', async () => {
      const name = `${suite} OutOfRange`;
      await post(validBody({ name, latitude: 91 })).expect(400);

      const rows = await database.db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM places WHERE name = ${name}`,
      );
      expect(rows.rows[0]?.count).toBe(0);
    });

    describe('authorization (§33)', () => {
      it('refuses an unauthenticated submission', async () => {
        const response = await post(validBody(), false).expect(401);
        expect((response.body as ErrorResponse).error.code).toBe('INVALID_TOKEN');
      });

      it('refuses an invalid token', async () => {
        await request(httpServer(app))
          .post('/api/v1/places')
          .set('Authorization', 'Bearer not-a-real-token')
          .send(validBody())
          .expect(401);
      });
    });

    describe('duplicate signal (§16, §52)', () => {
      it('flags a similar place nearby without blocking the submission', async () => {
        const name = `${suite} Padaria Central`;
        await createPlace(app, tokens, {
          name,
          latitude: LANDMARKS.boaViagem.latitude,
          longitude: LANDMARKS.boaViagem.longitude,
          categoryId: 'FOOD',
        });

        const response = await post({
          name,
          categoryId: 'FOOD',
          latitude: LANDMARKS.boaViagem.latitude + 0.0005,
          longitude: LANDMARKS.boaViagem.longitude,
        }).expect(201);

        const body = response.body as { possibleDuplicates: { name: string }[] };
        expect(body.possibleDuplicates.length).toBeGreaterThan(0);
        expect(body.possibleDuplicates[0]?.name).toBe(name);
      });

      it('does not flag the same name in another city', async () => {
        /* "Restaurante Central" exists in many cities; those are different places. */
        const name = `${suite} Restaurante Central`;
        await createPlace(app, tokens, {
          name,
          latitude: LANDMARKS.marcoZero.latitude,
          longitude: LANDMARKS.marcoZero.longitude,
          categoryId: 'FOOD',
        });

        const response = await post({
          name,
          categoryId: 'FOOD',
          latitude: LANDMARKS.saoPaulo.latitude,
          longitude: LANDMARKS.saoPaulo.longitude,
        }).expect(201);

        expect((response.body as { possibleDuplicates: unknown[] }).possibleDuplicates).toEqual([]);
      });

      it('does not flag a different category at the same spot', async () => {
        const name = `${suite} Mirante`;
        await createPlace(app, tokens, {
          name,
          latitude: LANDMARKS.jaboatao.latitude,
          longitude: LANDMARKS.jaboatao.longitude,
          categoryId: 'NATURE',
        });

        const response = await post({
          name,
          categoryId: 'FOOD',
          latitude: LANDMARKS.jaboatao.latitude,
          longitude: LANDMARKS.jaboatao.longitude,
        }).expect(201);

        expect((response.body as { possibleDuplicates: unknown[] }).possibleDuplicates).toEqual([]);
      });
    });

    it('writes an audit event owned by the places module (§34)', async () => {
      const created = await post(validBody()).expect(201);
      const id = (created.body as { place: { id: string } }).place.id;

      const rows = await database.db.execute<{ event_type: string; request_id: string | null }>(
        sql`SELECT event_type, request_id FROM place_audit_events WHERE place_id = ${id}`,
      );

      expect(rows.rows[0]?.event_type).toBe('PLACE_CREATED');
      expect(rows.rows[0]?.request_id).not.toBeNull();
    });

    it('keeps coordinates out of the audit record (§70)', async () => {
      const created = await post(validBody()).expect(201);
      const id = (created.body as { place: { id: string } }).place.id;

      const rows = await database.db.execute<{ payload: string | null }>(
        sql`SELECT metadata::text AS payload FROM place_audit_events WHERE place_id = ${id}`,
      );

      const payload = rows.rows[0]?.payload ?? '';
      expect(payload).not.toContain(String(LANDMARKS.marcoZero.latitude));
      expect(payload).not.toContain(String(LANDMARKS.marcoZero.longitude));
    });
  });

  describe('GET /places/:id (§23)', () => {
    it('returns a place without requiring a session', async () => {
      const place = await createPlace(app, tokens, {
        name: `${suite} Public Read`,
        latitude: LANDMARKS.marcoZero.latitude,
        longitude: LANDMARKS.marcoZero.longitude,
      });

      /* No Authorization header: reads are public (§33). */
      const response = await request(httpServer(app)).get(`/api/v1/places/${place.id}`).expect(200);

      expect((response.body as { name: string }).name).toBe(`${suite} Public Read`);
    });

    it('exposes only public contributor identity, never account data', async () => {
      const account = await registerAccount(app);
      const place = await createPlace(app, account.tokens, {
        name: `${suite} Attribution`,
        latitude: LANDMARKS.marcoZero.latitude,
        longitude: LANDMARKS.marcoZero.longitude,
      });

      const response = await request(httpServer(app)).get(`/api/v1/places/${place.id}`).expect(200);

      const serialised = JSON.stringify(response.body);
      expect(serialised).toContain(account.username);
      expect(serialised).not.toContain(account.email);
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('createdByUserId');
    });

    it('returns 404 for an unknown id', async () => {
      const response = await request(httpServer(app))
        .get('/api/v1/places/01a06cc8-9b3a-7ba0-879e-000000000000')
        .expect(404);

      expect((response.body as ErrorResponse).error.code).toBe('NOT_FOUND');
    });

    it('hides an archived place', async () => {
      const place = await createPlace(app, tokens, {
        name: `${suite} Archived`,
        latitude: LANDMARKS.marcoZero.latitude,
        longitude: LANDMARKS.marcoZero.longitude,
      });

      await database.db.execute(sql`UPDATE places SET status = 'ARCHIVED' WHERE id = ${place.id}`);

      await request(httpServer(app)).get(`/api/v1/places/${place.id}`).expect(404);
    });
  });

  describe('GET /places/categories', () => {
    it('lists the category vocabulary publicly', async () => {
      const response = await request(httpServer(app)).get('/api/v1/places/categories').expect(200);

      const ids = (response.body as { id: string }[]).map((c) => c.id);
      expect(ids).toContain('FOOD');
      expect(ids).toContain('NATURE');
      expect(ids.length).toBeGreaterThanOrEqual(9);
    });
  });
});
