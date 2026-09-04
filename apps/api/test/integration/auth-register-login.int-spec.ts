import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
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

/**
 * Registration and login against a real PostgreSQL (§49, §50).
 *
 * Nothing is mocked: the constraints, the Argon2 verification and the transaction
 * boundaries are exactly the ones production runs.
 */
describe('Registration and login', () => {
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

  describe('POST /auth/register', () => {
    it('creates an account and signs it in', async () => {
      const identity = uniqueIdentity();
      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...identity, password: VALID_PASSWORD })
        .expect(201);

      expect(response.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 600 });
      expect(tokensOf(response).accessToken).toEqual(expect.any(String));
      expect(tokensOf(response).refreshToken).toEqual(expect.any(String));
    });

    it('never returns the password or its hash', async () => {
      const identity = uniqueIdentity();
      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...identity, password: VALID_PASSWORD })
        .expect(201);

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(VALID_PASSWORD);
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('passwordHash');
    });

    it('rejects a duplicate email', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...uniqueIdentity(), email: account.email, password: VALID_PASSWORD })
        .expect(409);

      expect((response.body as ErrorResponse).error.code).toBe('EMAIL_ALREADY_IN_USE');
    });

    it('rejects an email differing only by case (§7)', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({
          ...uniqueIdentity(),
          email: account.email.toUpperCase(),
          password: VALID_PASSWORD,
        })
        .expect(409);

      expect((response.body as ErrorResponse).error.code).toBe('EMAIL_ALREADY_IN_USE');
    });

    it('rejects a duplicate username', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...uniqueIdentity(), username: account.username, password: VALID_PASSWORD })
        .expect(409);

      expect((response.body as ErrorResponse).error.code).toBe('USERNAME_ALREADY_IN_USE');
    });

    it('rejects a username differing only by case (§8)', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({
          ...uniqueIdentity(),
          username: account.username.toUpperCase(),
          password: VALID_PASSWORD,
        })
        .expect(409);

      expect((response.body as ErrorResponse).error.code).toBe('USERNAME_ALREADY_IN_USE');
    });

    it('normalises the stored email but preserves what the user typed', async () => {
      const identity = uniqueIdentity();
      const mixedCase = identity.email.replace('test-', 'Test-');

      const registered = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...identity, email: mixedCase, password: VALID_PASSWORD })
        .expect(201);

      const me = await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(tokensOf(registered)))
        .expect(200);

      expect(meOf(me).email).toBe(mixedCase);

      /* …and the normalised form is what enforces identity. */
      await request(httpServer(app))
        .post('/api/v1/auth/login')
        .send({ email: mixedCase.toLowerCase(), password: VALID_PASSWORD })
        .expect(200);
    });

    it('leaves nothing behind when the transaction rolls back (§30)', async () => {
      const account = await registerAccount(app);
      const identity = uniqueIdentity();

      /* The username is free but the email collides, so the whole unit must abort. */
      await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...identity, email: account.email, password: VALID_PASSWORD })
        .expect(409);

      /* If a partial write had leaked, this username would now be taken. */
      await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...identity, password: VALID_PASSWORD })
        .expect(201);
    });

    it.each([
      ['a short password', { password: 'short' }],
      ['a malformed email', { email: 'not-an-email' }],
      ['a username with a dot', { username: 'ana.souza' }],
      ['a reserved username', { username: 'admin' }],
      ['a blank display name', { displayName: '   ' }],
    ])('rejects %s with a validation error', async (_name, override) => {
      const response = await request(httpServer(app))
        .post('/api/v1/auth/register')
        .send({ ...uniqueIdentity(), password: VALID_PASSWORD, ...override })
        .expect(400);

      expect((response.body as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/login', () => {
    it('signs in with correct credentials', async () => {
      const account = await registerAccount(app);

      const response = await request(httpServer(app))
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(200);

      expect(tokensOf(response).accessToken).toEqual(expect.any(String));
      expect(tokensOf(response).refreshToken).not.toBe(account.tokens.refreshToken);
    });

    it('accepts the email in any case', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/auth/login')
        .send({ email: account.email.toUpperCase(), password: account.password })
        .expect(200);
    });

    describe('anti-enumeration (§27)', () => {
      it('returns the same code for a wrong password and an unknown account', async () => {
        const account = await registerAccount(app);

        const wrongPassword = await request(httpServer(app))
          .post('/api/v1/auth/login')
          .send({ email: account.email, password: 'a completely different phrase' })
          .expect(401);

        const unknownAccount = await request(httpServer(app))
          .post('/api/v1/auth/login')
          .send({ email: uniqueIdentity().email, password: VALID_PASSWORD })
          .expect(401);

        const wrong = (wrongPassword.body as ErrorResponse).error;
        const unknown = (unknownAccount.body as ErrorResponse).error;

        expect(wrong.code).toBe('INVALID_CREDENTIALS');
        expect(unknown.code).toBe(wrong.code);
        expect(unknown.message).toBe(wrong.message);
        /* No side channel in the payload either. */
        expect(unknown.details).toEqual(wrong.details);
      });

      it('spends comparable time on both, so timing is not an oracle', async () => {
        const account = await registerAccount(app);

        const time = async (email: string): Promise<number> => {
          const startedAt = performance.now();
          await request(httpServer(app))
            .post('/api/v1/auth/login')
            .send({ email, password: 'a completely different phrase' });
          return performance.now() - startedAt;
        };

        /* Take the median of several runs: a single sample is dominated by noise. */
        const median = async (email: string): Promise<number> => {
          const samples: number[] = [];
          for (let i = 0; i < 5; i += 1) samples.push(await time(email));
          return samples.sort((a, b) => a - b)[2] ?? 0;
        };

        const existing = await median(account.email);
        const missing = await median(uniqueIdentity().email);

        /* Both paths run a full Argon2 verification, so neither should be a small
           fraction of the other. Bounds are generous — this catches "returns
           instantly", not microsecond differences. */
        const ratio = Math.max(existing, missing) / Math.min(existing, missing);
        expect(ratio).toBeLessThan(3);
      });
    });

    it('rejects an account that cannot authenticate', async () => {
      const account = await registerAccount(app);

      /* Status is not settable through the API by design (§57); drive it directly. */
      const { DatabaseService } =
        await import('../../src/infrastructure/database/database.service.js');
      const database = app.get(DatabaseService);
      const { sql } = await import('drizzle-orm');
      await database.db.execute(
        sql`update users set status = 'DISABLED' where lower(email) = ${account.email.toLowerCase()}`,
      );

      const response = await request(httpServer(app))
        .post('/api/v1/auth/login')
        .send({ email: account.email, password: account.password })
        .expect(403);

      expect((response.body as ErrorResponse).error.code).toBe('ACCOUNT_DISABLED');
    });
  });
});
