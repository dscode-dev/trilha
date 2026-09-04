import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ROUTING_PROVIDER } from './domain/routing-provider.js';
import { MapboxRoutingProvider } from './infrastructure/mapbox-routing.provider.js';
import { CorridorRepository } from './infrastructure/corridor.repository.js';
import { CalculateRouteUseCase } from './application/calculate-route.use-case.js';
import { RoutesController } from './presentation/routes.controller.js';
import { RoutingRateLimitGuard } from './presentation/guards/routing-rate-limit.guard.js';

/**
 * The routing bounded context.
 *
 * The provider is bound to its port by token, which is the seam that keeps the use
 * case vendor-agnostic: swapping suppliers is a change to this one line.
 *
 * Owns no tables. A route is a computation, so PR-03 adds no migration (§73).
 */
@Module({
  imports: [DatabaseModule, RateLimitModule, IdentityModule],
  controllers: [RoutesController],
  providers: [
    { provide: ROUTING_PROVIDER, useClass: MapboxRoutingProvider },
    CorridorRepository,
    CalculateRouteUseCase,
    RoutingRateLimitGuard,
  ],
  /* Exported for PR-04, which needs a corridor to search Places along a route. */
  exports: [CorridorRepository],
})
export class RoutingModule {}
