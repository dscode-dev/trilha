import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { httpServer } from '../support/http.js';
import {
  VALID_PASSWORD,
  authHeader,
  meOf,
  clearRateLimits,
  registerAccount,
  tokensOf,
  uniqueIdentity,
} from '../support/identity.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/** `/me`, profile editing, password change and session lifecycle (§20–§24, §49). */
describe('Account, profile and sessions', () => {
  let app: INestApplication;
  let database: DatabaseService;

  const login = (email: string, password: string) =>
    request(httpServer(app)).post('/api/v1/auth/login').send({ email, password });

  const refresh = (token: string) =>
    request(httpServer(app)).post('/api/v1/auth/refresh').send({ refreshToken: token });

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    await clearRateLimits(app);
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /me (§22)', () => {
    it('returns identity and profile', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(account.tokens))
        .expect(200);

      const body = meOf(response);

      expect(typeof body.id).toBe('string');
      expect(body.email).toBe(account.email);
      expect(body.status).toBe('ACTIVE');
      expect(body.profile).toEqual({
        username: account.username,
        displayName: account.displayName,
        avatarUrl: null,
        bio: null,
      });
    });

    it('never exposes credentials or session internals', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(account.tokens))
        .expect(200);

      const serialised = JSON.stringify(response.body);
      for (const forbidden of ['passwordHash', 'password', 'argon2', 'refreshToken', 'sessionId']) {
        expect(serialised).not.toContain(forbidden);
      }
    });
  });

  describe('PATCH /me/profile (§23)', () => {
    it('updates the display name', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ displayName: 'Ana Renamed' })
        .expect(200);

      expect(meOf(response).profile.displayName).toBe('Ana Renamed');
      expect(meOf(response).profile.username).toBe(account.username);
    });

    it('updates the username and frees the previous one', async () => {
      const account = await registerAccount(app);
      const next = uniqueIdentity().username;

      await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ username: next })
        .expect(200);

      /* The old name is now available to somebody else. */
      await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...uniqueIdentity(), username: account.username, password: VALID_PASSWORD })
        .expect(201);
    });

    it('allows re-submitting the current username unchanged', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ username: account.username, displayName: 'Same Name Again' })
        .expect(200);
    });

    it('rejects a username taken by someone else', async () => {
      const other = await registerAccount(app);
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ username: other.username })
        .expect(409);

      expect((response.body as ErrorResponse).error.code).toBe('USERNAME_ALREADY_IN_USE');
    });

    it('sets and clears the bio', async () => {
      const account = await registerAccount(app);

      const set = await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ bio: 'Walks a lot.' })
        .expect(200);
      expect(meOf(set).profile.bio).toBe('Walks a lot.');

      const cleared = await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ bio: null })
        .expect(200);
      expect(meOf(cleared).profile.bio).toBeNull();
    });

    it('rejects an empty patch', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({})
        .expect(400);
    });

    it('ignores an attempt to set avatarUrl, which has no upload path in V1', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .set(...authHeader(account.tokens))
        .send({ displayName: 'Ana', avatarUrl: 'https://evil.example/x.png' })
        .expect(200);

      expect(meOf(response).profile.avatarUrl).toBeNull();
    });

    it('requires authentication', async () => {
      await request(httpServer(app))
        .patch('/api/v1/me/profile')
        .send({ displayName: 'Nobody' })
        .expect(401);
    });
  });

  describe('POST /auth/logout (§20)', () => {
    it('revokes the session so its refresh token stops working', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/auth/logout')
        .set(...authHeader(account.tokens))
        .expect(204);

      await refresh(account.tokens.refreshToken).expect(401);
    });

    it('rejects the access token once the session is revoked', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/auth/logout')
        .set(...authHeader(account.tokens))
        .expect(204);

      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(account.tokens))
        .expect(401);
    });

    it('leaves other sessions alone', async () => {
      const account = await registerAccount(app);
      const second = await login(account.email, account.password).expect(200);

      await request(httpServer(app))
        .post('/api/v1/auth/logout')
        .set(...authHeader(account.tokens))
        .expect(204);

      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(tokensOf(second)))
        .expect(200);
    });
  });

  describe('POST /auth/logout-all (§21)', () => {
    it('revokes every session, the caller’s included', async () => {
      const account = await registerAccount(app);
      const second = await login(account.email, account.password).expect(200);
      const third = await login(account.email, account.password).expect(200);

      const response = await request(httpServer(app))
        .post('/api/v1/auth/logout-all')
        .set(...authHeader(account.tokens))
        .expect(200);

      expect((response.body as { revokedCount: number }).revokedCount).toBe(3);

      for (const tokens of [account.tokens, second.body, third.body]) {
        await request(httpServer(app))
          .get('/api/v1/me')
          .set('Authorization', `Bearer ${(tokens as { accessToken: string }).accessToken}`)
          .expect(401);
        await refresh((tokens as { refreshToken: string }).refreshToken).expect(401);
      }
    });
  });

  describe('POST /me/change-password (§24)', () => {
    it('changes the password and revokes every session', async () => {
      const account = await registerAccount(app);
      await login(account.email, account.password).expect(200);

      const response = await request(httpServer(app))
        .post('/api/v1/me/change-password')
        .set(...authHeader(account.tokens))
        .send({ currentPassword: account.password, newPassword: 'an entirely new passphrase' })
        .expect(200);

      expect((response.body as { revokedSessions: number }).revokedSessions).toBe(2);

      /* Including the session that made the request (§24 policy). */
      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(account.tokens))
        .expect(401);
    });

    it('accepts the new password and rejects the old one afterwards', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/me/change-password')
        .set(...authHeader(account.tokens))
        .send({ currentPassword: account.password, newPassword: 'an entirely new passphrase' })
        .expect(200);

      await login(account.email, 'an entirely new passphrase').expect(200);
      await login(account.email, account.password).expect(401);
    });

    it('rejects a wrong current password and changes nothing', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .post('/api/v1/me/change-password')
        .set(...authHeader(account.tokens))
        .send({ currentPassword: 'not the password', newPassword: 'an entirely new passphrase' })
        .expect(401);

      expect((response.body as ErrorResponse).error.code).toBe('INVALID_CREDENTIALS');

      /* The original password still works and the session survives. */
      await login(account.email, account.password).expect(200);
    });

    it('rejects a new password that fails policy', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/me/change-password')
        .set(...authHeader(account.tokens))
        .send({ currentPassword: account.password, newPassword: 'short' })
        .expect(400);
    });

    it('rejects reusing the current password as the new one', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/me/change-password')
        .set(...authHeader(account.tokens))
        .send({ currentPassword: account.password, newPassword: account.password })
        .expect(400);
    });
  });

  describe('password storage (§49)', () => {
    it('never stores the password in plaintext and uses Argon2id', async () => {
      const account = await registerAccount(app);

      const rows = await database.db.execute<{ password_hash: string; algorithm: string }>(
        sql`select c.password_hash, c.algorithm from credentials c
            join users u on u.id = c.user_id
            where lower(u.email) = ${account.email.toLowerCase()}`,
      );

      const stored = rows.rows[0];
      expect(stored?.password_hash).not.toContain(account.password);
      expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
      expect(stored?.algorithm).toBe('argon2id');
    });

    it('uses the benchmarked parameters (§53)', async () => {
      const account = await registerAccount(app);

      const rows = await database.db.execute<{ password_hash: string }>(
        sql`select c.password_hash from credentials c
            join users u on u.id = c.user_id
            where lower(u.email) = ${account.email.toLowerCase()}`,
      );

      /* m=47104 KiB, t=3, p=1 — see PasswordHasher. */
      expect(rows.rows[0]?.password_hash).toContain('m=47104,t=3,p=1');
    });

    it('salts each hash, so identical passwords differ on disk', async () => {
      const first = await registerAccount(app, { password: VALID_PASSWORD });
      const second = await registerAccount(app, { password: VALID_PASSWORD });

      const rows = await database.db.execute<{ password_hash: string }>(
        sql`select c.password_hash from credentials c
            join users u on u.id = c.user_id
            where lower(u.email) in (${first.email.toLowerCase()}, ${second.email.toLowerCase()})`,
      );

      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.password_hash).not.toBe(rows.rows[1]?.password_hash);
    });
  });

  describe('audit trail (§28)', () => {
    it('records the authentication events with a correlation id', async () => {
      const account = await registerAccount(app);
      await login(account.email, account.password).expect(200);
      await login(account.email, 'wrong password entirely').expect(401);

      const rows = await database.db.execute<{ event_type: string; request_id: string | null }>(
        sql`select e.event_type, e.request_id from auth_audit_events e
            join users u on u.id = e.user_id
            where lower(u.email) = ${account.email.toLowerCase()}
            order by e.created_at`,
      );

      const types = rows.rows.map((row) => row.event_type);
      expect(types).toContain('REGISTER_SUCCEEDED');
      expect(types).toContain('LOGIN_SUCCEEDED');
      expect(types).toContain('LOGIN_FAILED');
      expect(rows.rows.every((row) => row.request_id !== null)).toBe(true);
    });

    it('hashes the client address rather than storing it (§18)', async () => {
      const account = await registerAccount(app);

      const rows = await database.db.execute<{ ip_hash: string | null }>(
        sql`select e.ip_hash from auth_audit_events e
            join users u on u.id = e.user_id
            where lower(u.email) = ${account.email.toLowerCase()} limit 1`,
      );

      const ipHash = rows.rows[0]?.ip_hash;
      expect(ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ipHash).not.toContain('127.0.0.1');
      expect(ipHash).not.toContain('::1');
    });
  });
});
