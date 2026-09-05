import { Injectable } from '@nestjs/common';
import {
  PlaceRepository,
  type AlongRouteQuery,
  type PlaceAlongRouteRow,
} from '../infrastructure/place.repository.js';

/**
 * The only thing Places exposes to Discovery (ADR-0001).
 *
 * Discovery needs to ask a spatial question about Places, and that question must be
 * answered *inside* Places: the table, its GIST index and the meaning of `status` all
 * belong here, and a second module writing SQL against `places` would make the
 * ownership rule a comment rather than a fact.
 *
 * A read-only service rather than the repository itself, because exporting
 * `PlaceRepository` would hand Discovery `create` and the audit path along with it.
 * A module should be able to grant exactly the capability it means to grant.
 */
@Injectable()
export class PlacesAlongRouteQuery {
  constructor(private readonly places: PlaceRepository) {}

  /** Active Places within the corridor, nearest to the line first, capped. */
  async execute(query: AlongRouteQuery): Promise<PlaceAlongRouteRow[]> {
    return this.places.findAlongRoute(query);
  }
}

export type { AlongRouteQuery, PlaceAlongRouteRow };
