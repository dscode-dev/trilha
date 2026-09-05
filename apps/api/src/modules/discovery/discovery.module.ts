import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PlacesModule } from '../places/places.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { DiscoverAlongRouteUseCase } from './application/discover-along-route.use-case.js';
import { ROUTE_COST_PROVIDER } from './domain/route-cost-provider.js';
import { ROUTE_RELEVANCE_POLICY, RouteRelevancePolicyV1 } from './domain/route-relevance.js';
import { MapboxRouteCostProvider } from './infrastructure/mapbox-route-cost.provider.js';
import { DiscoveryController } from './presentation/discovery.controller.js';
import { DiscoveryRateLimitGuard } from './presentation/guards/discovery-rate-limit.guard.js';

/**
 * The Discovery bounded context (§66, §67).
 *
 * Owns **no tables** and adds no migration: a `RouteCandidate` is derived from a
 * route, a Place and a policy, and all three already exist elsewhere (§45).
 *
 * It consumes three modules and reaches past none of them. `PlacesModule` exports one
 * read-only spatial query and nothing else, so discovery cannot write a Place;
 * `RoutingModule` exports the route calculation, so discovery never talks to a
 * directions provider itself; identity supplies the guard.
 *
 * The two ports are bound here and nowhere else. Swapping either — a different
 * travel-cost source, a v2 ranking policy — is a change to this file.
 */
@Module({
  imports: [RateLimitModule, IdentityModule, PlacesModule, RoutingModule],
  controllers: [DiscoveryController],
  providers: [
    DiscoverAlongRouteUseCase,
    { provide: ROUTE_COST_PROVIDER, useClass: MapboxRouteCostProvider },
    { provide: ROUTE_RELEVANCE_POLICY, useClass: RouteRelevancePolicyV1 },
    DiscoveryRateLimitGuard,
  ],
})
export class DiscoveryModule {}
