import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { BoundingBox, Coordinates } from '../domain/coordinates.js';
import { PlaceNotFoundError } from '../domain/place-errors.js';
import type { PlaceDetail, PlaceListItem, PlaceMapItem } from '../domain/place.js';
import { PlaceRepository } from '../infrastructure/place.repository.js';

/**
 * Read paths for Places (§17, §18, §22, §23).
 *
 * Pagination is offset-based (§28). Cursor pagination is the right answer for a deep,
 * stable feed; these are bounded proximity and viewport queries whose result sets are
 * small by construction — a radius is capped at 50 km, a viewport at 5° — so a cursor
 * would add machinery without removing a problem. Revisit if a listing ever grows
 * unbounded.
 */

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/**
 * Cap on markers returned for one viewport.
 *
 * A dense city view can hold thousands of places; drawing them all would stall the
 * map long before it helped anyone. The client zooms in for detail.
 */
export const MAP_ITEM_LIMIT = 300;

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  /** True when another page exists — computed by over-fetching one row. */
  hasMore: boolean;
}

@Injectable()
export class QueryPlacesUseCase {
  constructor(
    private readonly places: PlaceRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueryPlacesUseCase.name);
  }

  async byId(id: string): Promise<PlaceDetail> {
    const place = await this.places.findDetailById(id);
    if (place === undefined) throw new PlaceNotFoundError();
    return place;
  }

  async nearby(params: {
    coordinates: Coordinates;
    radiusMetres: number;
    categoryId?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<Page<PlaceListItem>> {
    const rows = await this.places.findNearby({
      coordinates: params.coordinates,
      radiusMetres: params.radiusMetres,
      categoryId: params.categoryId,
      /* One extra row answers "is there more?" without a second COUNT query. */
      limit: params.limit + 1,
      offset: params.offset,
    });

    /* Radius and result count are safe to record; the coordinates are not (§69, §70). */
    this.logger.debug(
      {
        event: 'places.nearby.query',
        radiusMetres: params.radiusMetres,
        resultCount: Math.min(rows.length, params.limit),
      },
      'Nearby query',
    );

    return toPage(rows, params.limit, params.offset);
  }

  async map(box: BoundingBox): Promise<{ items: PlaceMapItem[]; truncated: boolean }> {
    const rows = await this.places.findInBoundingBox(box, MAP_ITEM_LIMIT + 1);
    const truncated = rows.length > MAP_ITEM_LIMIT;

    this.logger.debug(
      { event: 'places.map.query', resultCount: Math.min(rows.length, MAP_ITEM_LIMIT), truncated },
      'Map viewport query',
    );

    return { items: rows.slice(0, MAP_ITEM_LIMIT), truncated };
  }

  async search(params: {
    term: string;
    categoryId?: string | undefined;
    near?: Coordinates | undefined;
    limit: number;
    offset: number;
  }): Promise<Page<PlaceListItem>> {
    const rows = await this.places.search({
      term: params.term,
      categoryId: params.categoryId,
      near: params.near,
      limit: params.limit + 1,
      offset: params.offset,
    });

    /* The query text is user content and stays out of logs and metrics (§69). */
    this.logger.debug(
      { event: 'places.search', termLength: params.term.length, resultCount: rows.length },
      'Place search',
    );

    return toPage(rows, params.limit, params.offset);
  }

  async categories(): Promise<{ id: string; label: string }[]> {
    return this.places.listCategories();
  }
}

function toPage<T>(rows: T[], limit: number, offset: number): Page<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, limit, offset, hasMore };
}
