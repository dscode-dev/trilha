import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './infrastructure/config/config.module.js';
import { LoggingModule } from './common/logging/logging.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { CacheModule } from './infrastructure/cache/cache.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { PlacesModule } from './modules/places/places.module.js';
import { RoutingModule } from './modules/routing/routing.module.js';
import { DiscoveryModule } from './modules/discovery/discovery.module.js';
import { RequestIdMiddleware } from './common/http/request-id.middleware.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { NotFoundModule } from './common/http/not-found.module.js';

/**
 * Composition root of the modular monolith (ADR-0001).
 *
 * `infrastructure/*` provides technical capabilities; `modules/*` holds bounded
 * contexts. Modules are added by the PR that owns them — the constitution forbids
 * scaffolding a domain ahead of that.
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    CacheModule,
    HealthModule,
    IdentityModule,
    PlacesModule,
    RoutingModule,
    DiscoveryModule,
    /* Last: its wildcard route must not shadow a real one. */
    NotFoundModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /* Runs before every route so no request can escape correlation (§12). */
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
