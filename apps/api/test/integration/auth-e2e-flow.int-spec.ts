import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { httpServer } from '../support/http.js';
import { VALID_PASSWORD, clearRateLimits, uniqueIdentity } from '../support/identity.js';

/**
 * The complete journeys from §52, exercised end to end in one sequence each.
 *
 * The per-endpoint suites cover the branches; these two exist to prove the whole
 * flow holds together in order, the way a real client drives it.
 */
describe('End-to-end authentication flows', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    await clearRateLimits(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const bearer = (accessToken: string): [string, string] => [
    'Authorization',
    `Bearer ${accessToken}`,
  ];

  it('register → me → refresh → old refresh rejected → me → logout → refresh rejected', async () => {
    const identity = uniqueIdentity();

    /* 1. register */
    const registered = await request(httpServer(app))
      .post('/api/v1/auth/register')
      .send({ ...identity, password: VALID_PASSWORD })
      .expect(201);

    const first = registered.body as { accessToken: string; refreshToken: string };

    /* 2. the access token works */
    const me = await request(httpServer(app))
      .get('/api/v1/me')
      .set(...bearer(first.accessToken))
      .expect(200);
    expect((me.body as { email: string }).email).toBe(identity.email);

    /* 3. refresh rotates the pair */
    const rotated = await request(httpServer(app))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(200);

    const second = rotated.body as { accessToken: string; refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);

    /* 4. the consumed token is dead */
    await request(httpServer(app))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);

    /* 5. …and reuse revoked the session, so the successor is dead too */
    await request(httpServer(app))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.refreshToken })
      .expect(401);

    await request(httpServer(app))
      .get('/api/v1/me')
      .set(...bearer(second.accessToken))
      .expect(401);

    /* 6. signing in again produces a fresh, working session */
    const reLogin = await request(httpServer(app))
      .post('/api/v1/auth/login')
      .send({ email: identity.email, password: VALID_PASSWORD })
      .expect(200);

    const third = reLogin.body as { accessToken: string; refreshToken: string };

    await request(httpServer(app))
      .get('/api/v1/me')
      .set(...bearer(third.accessToken))
      .expect(200);

    /* 7. logout ends it */
    await request(httpServer(app))
      .post('/api/v1/auth/logout')
      .set(...bearer(third.accessToken))
      .expect(204);

    await request(httpServer(app))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: third.refreshToken })
      .expect(401);
  });

  it('register → second session → logout-all → both sessions invalid', async () => {
    const identity = uniqueIdentity();

    const registered = await request(httpServer(app))
      .post('/api/v1/auth/register')
      .send({ ...identity, password: VALID_PASSWORD })
      .expect(201);
    const sessionA = registered.body as { accessToken: string; refreshToken: string };

    const loggedIn = await request(httpServer(app))
      .post('/api/v1/auth/login')
      .send({ email: identity.email, password: VALID_PASSWORD })
      .expect(200);
    const sessionB = loggedIn.body as { accessToken: string; refreshToken: string };

    /* Both are live. */
    await request(httpServer(app))
      .get('/api/v1/me')
      .set(...bearer(sessionA.accessToken))
      .expect(200);
    await request(httpServer(app))
      .get('/api/v1/me')
      .set(...bearer(sessionB.accessToken))
      .expect(200);

    const revoked = await request(httpServer(app))
      .post('/api/v1/auth/logout-all')
      .set(...bearer(sessionB.accessToken))
      .expect(200);
    expect((revoked.body as { revokedCount: number }).revokedCount).toBe(2);

    /* Neither survives — including the one that issued the request. */
    for (const session of [sessionA, sessionB]) {
      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...bearer(session.accessToken))
        .expect(401);
      await request(httpServer(app))
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    }
  });

  it('register → change password → every session ends → new password works', async () => {
    const identity = uniqueIdentity();
    const nextPassword = 'a different quiet trail entirely';

    const registered = await request(httpServer(app))
      .post('/api/v1/auth/register')
      .send({ ...identity, password: VALID_PASSWORD })
      .expect(201);
    const session = registered.body as { accessToken: string; refreshToken: string };

    await request(httpServer(app))
      .post('/api/v1/me/change-password')
      .set(...bearer(session.accessToken))
      .send({ currentPassword: VALID_PASSWORD, newPassword: nextPassword })
      .expect(200);

    /* The calling session is revoked too (§24 policy). */
    await request(httpServer(app))
      .get('/api/v1/me')
      .set(...bearer(session.accessToken))
      .expect(401);
    await request(httpServer(app))
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);

    /* The old password is gone; the new one works. */
    await request(httpServer(app))
      .post('/api/v1/auth/login')
      .send({ email: identity.email, password: VALID_PASSWORD })
      .expect(401);

    await request(httpServer(app))
      .post('/api/v1/auth/login')
      .send({ email: identity.email, password: nextPassword })
      .expect(200);
  });
});
