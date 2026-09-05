import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PlacesModule } from '../places/places.module.js';
import { RoutingModule } from '../routing/routing.module.js';
import { TrailBuilderService } from './application/trail-builder.service.js';
import { TrailRepository } from './infrastructure/trail.repository.js';
import { TrailsController } from './presentation/trails.controller.js';
import { TrailMutationRateLimitGuard } from './presentation/guards/trail-mutation-rate-limit.guard.js';

/**
 * The Trails bounded context (PR-05).
 *
 * Owns `trails` and `trail_stops`, and reaches into nobody else's tables. It resolves
 * Places through the one read capability `PlacesModule` exports, and routes through
 * `CalculateRouteUseCase` — so it never talks to a routing provider itself and cannot
 * write a Place (ADR-0001).
 *
 * Note what is absent: no publication service, no share links, no ratings. A Trail is
 * private to its owner in PR-05, and the module has no code that could make it
 * otherwise.
 */
@Module({
  imports: [DatabaseModule, RateLimitModule, IdentityModule, PlacesModule, RoutingModule],
  controllers: [TrailsController],
  providers: [TrailRepository, TrailBuilderService, TrailMutationRateLimitGuard],
})
export class TrailsModule {}
