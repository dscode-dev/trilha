import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createApp } from '../../src/bootstrap.js';
import { runMigrations } from '../../src/infrastructure/database/migrate.js';
import { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { httpServer } from '../support/http.js';
import { authHeader, registerAccount, tokensOf } from '../support/identity.js';
import type { ErrorResponse } from '../../src/common/errors/error-response.js';

/**
 * Refresh rotation, reuse detection and concurrency (§15, §16, §17, §49).
 *
 * The concurrency case is the load-bearing one: the guarantee is a property of the
 * SQL, so it is exercised against a real PostgreSQL rather than reasoned about.
 */
describe('Refresh token rotation', () => {
  let app: INestApplication;
  let database: DatabaseService;

  const refresh = (token: string) =>
    request(httpServer(app)).post('/api/v1/auth/refresh').send({ refreshToken: token });

  beforeAll(async () => {
    await runMigrations();
    app = await createApp();
    await app.init();
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('rotation (§15)', () => {
    it('issues a new pair and invalidates the presented token', async () => {
      const account = await registerAccount(app);

      const rotated = await refresh(account.tokens.refreshToken).expect(200);
      expect(tokensOf(rotated).refreshToken).not.toBe(account.tokens.refreshToken);
      expect(tokensOf(rotated).accessToken).toEqual(expect.any(String));

      /* The new token works… */
      await refresh(tokensOf(rotated).refreshToken).expect(200);
    });

    it('produces an access token that authenticates', async () => {
      const account = await registerAccount(app);
      const rotated = await refresh(account.tokens.refreshToken).expect(200);

      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(tokensOf(rotated)))
        .expect(200);
    });

    it('advances lastUsedAt on refresh, not on ordinary requests (§19)', async () => {
      const account = await registerAccount(app);

      const readLastUsed = async (): Promise<string> => {
        const result = await database.db.execute<{ last_used_at: Date }>(
          sql`select s.last_used_at from sessions s
              join users u on u.id = s.user_id
              where lower(u.email) = ${account.email.toLowerCase()}
              order by s.created_at desc limit 1`,
        );
        return String(result.rows[0]?.last_used_at);
      };

      const initial = await readLastUsed();

      /* Authenticated reads must not write. */
      for (let i = 0; i < 3; i += 1) {
        await request(httpServer(app))
          .get('/api/v1/me')
          .set(...authHeader(account.tokens))
          .expect(200);
      }
      expect(await readLastUsed()).toBe(initial);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await refresh(account.tokens.refreshToken).expect(200);
      expect(await readLastUsed()).not.toBe(initial);
    });
  });

  describe('reuse detection (§16)', () => {
    it('rejects a token that was already rotated', async () => {
      const account = await registerAccount(app);
      await refresh(account.tokens.refreshToken).expect(200);

      const replayed = await refresh(account.tokens.refreshToken).expect(401);
      expect((replayed.body as ErrorResponse).error.code).toBe('SESSION_EXPIRED');
    });

    it('revokes the whole family, killing the legitimate successor too', async () => {
      const account = await registerAccount(app);
      const rotated = await refresh(account.tokens.refreshToken).expect(200);

      /* Replaying the consumed token is treated as compromise… */
      await refresh(account.tokens.refreshToken).expect(401);

      /* …so the successor issued moments earlier dies with the session. This is the
         intended trade: a thief must not keep a live session. */
      await refresh(tokensOf(rotated).refreshToken).expect(401);
    });

    it('invalidates access tokens from the revoked session', async () => {
      const account = await registerAccount(app);
      const rotated = await refresh(account.tokens.refreshToken).expect(200);

      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(tokensOf(rotated)))
        .expect(200);

      await refresh(account.tokens.refreshToken).expect(401);

      await request(httpServer(app))
        .get('/api/v1/me')
        .set(...authHeader(tokensOf(rotated)))
        .expect(401);
    });

    it('records REFRESH_REUSE_DETECTED in the audit trail (§28)', async () => {
      const account = await registerAccount(app);
      await refresh(account.tokens.refreshToken).expect(200);
      await refresh(account.tokens.refreshToken).expect(401);

      const events = await database.db.execute<{ event_type: string }>(
        sql`select e.event_type from auth_audit_events e
            join users u on u.id = e.user_id
            where lower(u.email) = ${account.email.toLowerCase()}
              and e.event_type = 'REFRESH_REUSE_DETECTED'`,
      );

      expect(events.rows).toHaveLength(1);
    });

    it('does not leak the token in the audit record', async () => {
      const account = await registerAccount(app);
      await refresh(account.tokens.refreshToken).expect(200);
      await refresh(account.tokens.refreshToken).expect(401);

      const events = await database.db.execute<{ payload: string | null }>(
        sql`select e.metadata::text as payload from auth_audit_events e
            join users u on u.id = e.user_id
            where lower(u.email) = ${account.email.toLowerCase()}`,
      );

      expect(events.rows.length).toBeGreaterThan(0);
      for (const row of events.rows) {
        /* metadata is nullable; a null row trivially carries no token. */
        if (row.payload !== null) {
          expect(row.payload).not.toContain(account.tokens.refreshToken);
        }
      }
    });
  });

  describe('rejected tokens', () => {
    it('rejects a forged token', async () => {
      await refresh('not-a-real-token-value-at-all').expect(401);
    });

    it('rejects a malformed body', async () => {
      await request(httpServer(app))
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: '' })
        .expect(400);
    });

    it('rejects a token whose session was revoked by logout', async () => {
      const account = await registerAccount(app);

      await request(httpServer(app))
        .post('/api/v1/auth/logout')
        .set(...authHeader(account.tokens))
        .expect(204);

      await refresh(account.tokens.refreshToken).expect(401);
    });

    it('rejects an expired token', async () => {
      const account = await registerAccount(app);

      await database.db.execute(
        sql`update refresh_tokens set expires_at = now() - interval '1 minute'
            where session_id in (
              select s.id from sessions s join users u on u.id = s.user_id
              where lower(u.email) = ${account.email.toLowerCase()})`,
      );

      const response = await refresh(account.tokens.refreshToken).expect(401);
      expect((response.body as ErrorResponse).error.code).toBe('SESSION_EXPIRED');
    });

    it('rejects a token whose session has expired', async () => {
      const account = await registerAccount(app);

      await database.db.execute(
        sql`update sessions set expires_at = now() - interval '1 minute'
            where user_id in (select id from users where lower(email) = ${account.email.toLowerCase()})`,
      );

      await refresh(account.tokens.refreshToken).expect(401);
    });
  });

  /**
   * The invariant §17 and §72 exist for.
   *
   * Driven over a real listening socket rather than supertest, which starts an
   * ephemeral server per request and resets connections under this much parallelism.
   * Using one bound port means these requests contend the way production traffic does,
   * and the conditional UPDATE in PostgreSQL is what decides the winner — no
   * application-level lock is involved.
   */
  describe('concurrent rotation (§17)', () => {
    let baseUrl: string;

    beforeAll(async () => {
      await app.listen(0, '127.0.0.1');
      baseUrl = await app.getUrl();
    });

    const refreshOverSocket = async (token: string): Promise<number> => {
      const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      return response.status;
    };

    it.each([2, 10, 25, 50])(
      'admits exactly one winner out of %i simultaneous refreshes',
      async (attempts) => {
        const account = await registerAccount(app);

        const statuses = await Promise.all(
          Array.from({ length: attempts }, () => refreshOverSocket(account.tokens.refreshToken)),
        );

        expect(statuses.filter((status) => status === 200)).toHaveLength(1);
        expect(statuses.filter((status) => status === 401)).toHaveLength(attempts - 1);
      },
    );

    it('issues exactly one replacement token under contention', async () => {
      const account = await registerAccount(app);

      const bodies = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: account.tokens.refreshToken }),
          });
          return response.ok ? ((await response.json()) as { refreshToken: string }) : null;
        }),
      );

      const issued = new Set(
        bodies.filter((body) => body !== null).map((body) => body.refreshToken),
      );
      expect(issued.size).toBe(1);
    });

    it('marks the token used exactly once in the database', async () => {
      const account = await registerAccount(app);

      await Promise.all(
        Array.from({ length: 20 }, () => refreshOverSocket(account.tokens.refreshToken)),
      );

      const rows = await database.db.execute<{ used: number }>(
        sql`select count(*)::int as used from refresh_tokens rt
            join sessions s on s.id = rt.session_id
            join users u on u.id = s.user_id
            where lower(u.email) = ${account.email.toLowerCase()} and rt.used_at is not null`,
      );

      expect(rows.rows[0]?.used).toBe(1);
    });
  });
});
