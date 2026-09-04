import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  PlaceAuditEventType,
  PlaceAuditRepository,
} from '../infrastructure/place-audit.repository.js';
import type { Coordinates } from '../domain/coordinates.js';
import { UnknownPlaceCategoryError } from '../domain/place-errors.js';
import { PlaceProvenance, normaliseText, type PlaceListItem } from '../domain/place.js';
import { PlaceRepository } from '../infrastructure/place.repository.js';

export interface CreatePlaceInput {
  name: string;
  categoryId: string;
  coordinates: Coordinates;
  description: string | null;
  /** The authenticated submitter. Never taken from the request body (§24). */
  userId: string;
  requestId: string | null;
}

export interface CreatePlaceOutput {
  placeId: string;
  /** Nearby places that look similar — advisory, never a rejection (§16, §52). */
  possibleDuplicates: PlaceListItem[];
}

/** How close two similarly named places must be before it is worth mentioning. */
const DUPLICATE_RADIUS_METRES = 250;
const DUPLICATE_LIMIT = 5;

/**
 * Records a community-submitted Place (§24).
 *
 * The client supplies what it observed — a name, a category, a point, a description.
 * Everything that carries authority is decided here: who submitted it, where it came
 * from, and whether it is visible. A client that sends `provenance: SYSTEM` gets it
 * ignored, because the field is never read from the request.
 */
@Injectable()
export class CreatePlaceUseCase {
  constructor(
    private readonly places: PlaceRepository,
    private readonly audit: PlaceAuditRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CreatePlaceUseCase.name);
  }

  async execute(input: CreatePlaceInput): Promise<CreatePlaceOutput> {
    if (!(await this.places.categoryExists(input.categoryId))) {
      throw new UnknownPlaceCategoryError(input.categoryId);
    }

    const name = normaliseText(input.name);
    const description =
      input.description === null ? null : normaliseText(input.description) || null;

    /* Gathered before the insert so the response can point at what already exists.
       Advisory only: two restaurants with the same name in different cities are two
       places, and blocking on name similarity alone would be wrong. */
    const possibleDuplicates = await this.places.findPossibleDuplicates({
      name,
      categoryId: input.categoryId,
      coordinates: input.coordinates,
      radiusMetres: DUPLICATE_RADIUS_METRES,
      limit: DUPLICATE_LIMIT,
    });

    const placeId = await this.places.create({
      name,
      categoryId: input.categoryId,
      coordinates: input.coordinates,
      description,
      /* Server-decided, both of them (§11, §24). */
      provenance: PlaceProvenance.COMMUNITY,
      createdByUserId: input.userId,
    });

    await this.audit.record({
      eventType: PlaceAuditEventType.PLACE_CREATED,
      placeId,
      actorUserId: input.userId,
      requestId: input.requestId,
      /* Identifiers and counts only — never the coordinates, which would put a
         user's whereabouts in an audit table (§70). */
      metadata: {
        categoryId: input.categoryId,
        possibleDuplicates: possibleDuplicates.length,
      },
    });

    this.logger.info(
      { event: 'places.created', placeId, categoryId: input.categoryId },
      'Place created',
    );

    return { placeId, possibleDuplicates };
  }
}
