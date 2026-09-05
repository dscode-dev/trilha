import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PlaceRepository } from './infrastructure/place.repository.js';
import { PlaceAuditRepository } from './infrastructure/place-audit.repository.js';
import { CreatePlaceUseCase } from './application/create-place.use-case.js';
import { QueryPlacesUseCase } from './application/query-places.use-case.js';
import { PlacesAlongRouteQuery } from './application/places-along-route.query.js';
import { PlaceLookupQuery } from './application/place-lookup.query.js';
import { PlacesController } from './presentation/places.controller.js';

/**
 * The Places bounded context.
 *
 * Depends on `IdentityModule` only for `AuthGuard` — the single thing identity
 * exports. It owns its own tables, including its audit log, so nothing here reaches
 * into another module's storage (ADR-0001).
 */
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [PlacesController],
  providers: [
    PlaceRepository,
    PlaceAuditRepository,
    CreatePlaceUseCase,
    QueryPlacesUseCase,
    PlacesAlongRouteQuery,
    PlaceLookupQuery,
  ],
  /* Other contexts get exactly the read capability they need, never the repository,
     which would also grant writes: Discovery (PR-04) asks a spatial question, Trails
     (PR-05) resolves a Place id. */
  exports: [PlacesAlongRouteQuery, PlaceLookupQuery],
})
export class PlacesModule {}
