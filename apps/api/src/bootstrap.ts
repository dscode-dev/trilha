import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module.js';
import { AppConfig } from './infrastructure/config/app-config.js';
import { ErrorResponse } from './common/errors/error-response.js';

export const API_VERSION = '0.0.0';

/**
 * Builds a fully configured Nest application.
 *
 * Shared by `main.ts`, the OpenAPI exporter and integration tests, so the code under
 * test is the code that runs in production — no divergent test-only wiring.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    /* Pino replaces Nest's default logger; buffer until it is attached so no
       startup line is lost or printed unstructured. */
    bufferLogs: true,
    /* Nest's default is process.abort(), which produces a core dump and hides the
       cause. Surfacing the error lets main.ts log it structured and exit non-zero. */
    abortOnError: false,
  });

  const config = app.get(AppConfig);
  app.useLogger(app.get(Logger));

  app.setGlobalPrefix(config.http.globalPrefix);

  /* --- Security baseline (§30) --- */
  /* The Swagger UI needs inline scripts/styles, so CSP is relaxed only where docs are served. */
  app.use(helmet(config.docs.enabled ? { contentSecurityPolicy: false } : {}));
  app.use(json({ limit: config.http.bodyLimit }));
  app.use(urlencoded({ extended: true, limit: config.http.bodyLimit }));

  app.enableCors({
    origin: config.http.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  });

  /* Request validation is Zod-based (`common/validation/zod-validation.pipe.ts`),
     applied per route as DTOs are introduced. Nest's built-in ValidationPipe is
     deliberately not registered: it requires class-validator, and running two
     validation stacks side by side is how contracts drift. */

  /* Lets in-flight requests finish and closes pools on SIGTERM. */
  app.enableShutdownHooks();

  if (config.docs.enabled) {
    setupOpenApi(app, config);
  }

  return app;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('Trilha API')
    .setDescription(
      'Trilha platform API. PR-00 exposes platform endpoints only; product domains ' +
        'are introduced by their own pull requests.',
    )
    .setVersion(API_VERSION)
    .addServer('/api/v1')
    .addTag('platform', 'Liveness, readiness and other operational endpoints')
    .build();

  return SwaggerModule.createDocument(app, builder, {
    extraModels: [ErrorResponse],
  });
}

function setupOpenApi(app: INestApplication, config: AppConfig): void {
  SwaggerModule.setup(config.docs.path, app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'Trilha API — OpenAPI',
  });
}
