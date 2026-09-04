import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';

/** The application type supertest accepts, derived from its own signature. */
type SupertestApp = Parameters<typeof request>[0];

/**
 * `INestApplication.getHttpServer()` is typed `any`, which would silently disable
 * type checking across every request in the suite. Narrowing it once, here, keeps
 * the assertions in the tests themselves fully checked.
 */
export function httpServer(app: INestApplication): SupertestApp {
  return app.getHttpServer() as SupertestApp;
}
