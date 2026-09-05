import { Injectable } from '@nestjs/common';
import { PlaceRepository } from '../infrastructure/place.repository.js';
import { isPubliclyVisible, type PlaceStatus } from '../domain/place.js';

/** The minimum another module needs to reference a Place (ADR-0001). */
export interface PlaceReference {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly status: PlaceStatus;
  readonly isVisible: boolean;
}

/**
 * Resolves a Place id for another bounded context.
 *
 * A read-only service rather than the repository itself, for the same reason
 * `PlacesAlongRouteQuery` is one: Trails needs to *reference* a Place, and exporting
 * `PlaceRepository` would hand it `create` and the audit path along with it. A module
 * should grant exactly the capability it means to grant.
 */
@Injectable()
export class PlaceLookupQuery {
  constructor(private readonly places: PlaceRepository) {}

  async byId(placeId: string): Promise<PlaceReference | undefined> {
    const place = await this.places.findDetailById(placeId);
    if (place === undefined) return undefined;

    return {
      id: place.id,
      name: place.name,
      categoryId: place.categoryId,
      latitude: place.latitude,
      longitude: place.longitude,
      status: place.status,
      /* Whether readers may see it. Callers decide what that means for them — a Trail
         keeps a stop whose Place was later archived (§51), but will not add a new
         one. */
      isVisible: isPubliclyVisible(place.status),
    };
  }
}
