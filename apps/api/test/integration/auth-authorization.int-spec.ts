import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { httpServer } from '../support/http.js';
import { authHeader, registerAccount } from '../support/identity.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/**
 * Access-token validation at the guard (§49 — Authorization).
 *
 * Tokens are minted here with the real signing key so each rejection reason is
 * isolated: a wrong audience must fail even though the signature is perfectly valid.
 */
describe('Access token authorization', () => {
  let app: INestApplication;
  let secret: Uint8Array;

  const PROTECTED = '/api/v1/me';

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    secret = new TextEncoder().encode(process.env['JWT_ACCESS_SECRET']);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Mints a token with deliberately wrong claims. */
  const mint = async (overrides: {
    sub?: string;
    sid?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
    key?: Uint8Array;
  }): Promise<string> =>
    new SignJWT({ sid: overrides.sid ?? '01a06cc8-9b3a-7ba0-879e-f01610559f9c' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(overrides.sub ?? '01a06cc8-9b3a-7ba0-879e-f01610559f9d')
      .setIssuer(overrides.issuer ?? 'trilha-api')
      .setAudience(overrides.audience ?? 'trilha-mobile')
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? '10m')
      .sign(overrides.key ?? secret);

  it('accepts a valid token', async () => {
    const account = await registerAccount(app);
    await request(httpServer(app))
      .get(PROTECTED)
      .set(...authHeader(account.tokens))
      .expect(200);
  });

  describe('rejects', () => {
    it('a request with no Authorization header', async () => {
      const response = await request(httpServer(app)).get(PROTECTED).expect(401);
      expect((response.body as ErrorResponse).error.code).toBe('INVALID_TOKEN');
    });

    it.each([
      ['an empty header', ''],
      ['a bare token with no scheme', 'sometoken'],
      ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
      ['Bearer with no value', 'Bearer'],
      ['Bearer with an empty value', 'Bearer '],
      ['extra segments', 'Bearer a b'],
      ['a non-JWT value', 'Bearer not.a.jwt'],
    ])('%s', async (_name, header) => {
      await request(httpServer(app)).get(PROTECTED).set('Authorization', header).expect(401);
    });

    it('a token signed with the wrong key', async () => {
      const token = await mint({
        key: new TextEncoder().encode('a-different-key-that-is-long-enough-000000'),
      });
      await request(httpServer(app))
        .get(PROTECTED)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('a token from the wrong issuer', async () => {
      const token = await mint({ issuer: 'someone-else' });
      await request(httpServer(app))
        .get(PROTECTED)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('a token for the wrong audience', async () => {
      const token = await mint({ audience: 'another-app' });
      await request(httpServer(app))
        .get(PROTECTED)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('an expired token', async () => {
      const token = await mint({ expiresIn: '-1m' });
      await request(httpServer(app))
        .get(PROTECTED)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('a well-formed token naming a session that does not exist', async () => {
      const token = await mint({});
      const response = await request(httpServer(app))
        .get(PROTECTED)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);

      expect((response.body as ErrorResponse).error.code).toBe('SESSION_EXPIRED');
    });

    it('a token whose subject disagrees with its session', async () => {
      const account = await registerAccount(app);
      const [, payload] = account.tokens.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as {
        sid: string;
      };

      /* Real session, but a different user claimed as the subject. */
      const token = await mint({
        sid: claims.sid,
        sub: '01a06cc8-9b3a-7ba0-879e-000000000000',
      });

      await request(httpServer(app))
        .get(PROTECTED)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  it('never leaks the token back in an error response', async () => {
    const token = await mint({ expiresIn: '-1m' });
    const response = await request(httpServer(app))
      .get(PROTECTED)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(JSON.stringify(response.body)).not.toContain(token);
  });
});
