import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import {
  boundingBoxSchema,
  latitudeSchema,
  longitudeSchema,
  radiusMetresSchema,
} from '../../domain/coordinates.js';
import { PLACE_DESCRIPTION_MAX_LENGTH, PLACE_NAME_MAX_LENGTH } from '../../domain/place.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../../application/query-places.use-case.js';

/**
 * Transport contracts for Places.
 *
 * As in identity: a Zod schema does the runtime validation, and a decorated class
 * feeds `@nestjs/swagger`. The API speaks degrees of latitude and longitude, never
 * Web Mercator or a projected unit — projection is a rendering concern for the map
 * client, not part of the domain (§20).
 */

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const createPlaceSchema = z.object({
  name: z.string().trim().min(1).max(PLACE_NAME_MAX_LENGTH),
  categoryId: z.string().trim().min(1).max(40),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  description: z.string().trim().max(PLACE_DESCRIPTION_MAX_LENGTH).nullish(),
});

export const nearbyQuerySchema = paginationSchema.extend({
  lat: latitudeSchema,
  lng: longitudeSchema,
  radiusMeters: radiusMetresSchema,
  categoryId: z.string().trim().min(1).max(40).optional(),
});

export const mapQuerySchema = boundingBoxSchema;

export const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(2).max(80),
  categoryId: z.string().trim().min(1).max(40).optional(),
  /* Optional reference point, so results can be ordered by proximity. */
  lat: latitudeSchema.optional(),
  lng: longitudeSchema.optional(),
});

export type CreatePlaceBody = z.infer<typeof createPlaceSchema>;
export type NearbyQuery = z.infer<typeof nearbyQuerySchema>;
export type MapQuery = z.infer<typeof mapQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/* ---- OpenAPI shapes (§35) ------------------------------------------------ */

export class CreatePlaceRequestDto {
  @ApiProperty({ maxLength: PLACE_NAME_MAX_LENGTH, example: 'Marco Zero' })
  name!: string;

  @ApiProperty({ example: 'LANDMARK', description: 'An id from GET /places/categories.' })
  categoryId!: string;

  @ApiProperty({ minimum: -90, maximum: 90, example: -8.0631 })
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180, example: -34.8711 })
  longitude!: number;

  @ApiPropertyOptional({ maxLength: PLACE_DESCRIPTION_MAX_LENGTH, nullable: true, type: String })
  description?: string | null;
}

export class PlaceMapItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Marco Zero' })
  name!: string;

  @ApiProperty({ example: 'LANDMARK' })
  categoryId!: string;

  @ApiProperty({ example: -8.0631 })
  latitude!: number;

  @ApiProperty({ example: -34.8711 })
  longitude!: number;
}

export class PlaceListItemDto extends PlaceMapItemDto {
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Metres from the query point. Null when the query had no reference point.',
    example: 850,
  })
  distanceMetres!: number | null;
}

export class PlaceContributorDto {
  @ApiProperty({ example: 'ana-souza' })
  username!: string;

  @ApiProperty({ example: 'Ana Souza' })
  displayName!: string;
}

export class PlaceDetailDto extends PlaceMapItemDto {
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({
    enum: ['COMMUNITY', 'SYSTEM'],
    description: 'Where this record came from.',
    example: 'COMMUNITY',
  })
  provenance!: string;

  @ApiProperty({ enum: ['ACTIVE', 'PENDING_REVIEW', 'ARCHIVED'], example: 'ACTIVE' })
  status!: string;

  @ApiProperty({ example: '2026-09-04T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-09-04T12:00:00.000Z' })
  updatedAt!: string;

  @ApiProperty({
    type: PlaceContributorDto,
    nullable: true,
    description: 'Public attribution for a community submission. Never an email or account id.',
  })
  contributor!: PlaceContributorDto | null;
}

export class PlacePageDto {
  @ApiProperty({ type: [PlaceListItemDto] })
  items!: PlaceListItemDto[];

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;

  @ApiProperty({ example: false })
  hasMore!: boolean;
}

export class PlaceMapResponseDto {
  @ApiProperty({ type: [PlaceMapItemDto] })
  items!: PlaceMapItemDto[];

  @ApiProperty({
    example: false,
    description: 'True when the viewport held more places than the response cap. Zoom in.',
  })
  truncated!: boolean;
}

export class PlaceCategoryDto {
  @ApiProperty({ example: 'FOOD' })
  id!: string;

  @ApiProperty({ example: 'Food & drink' })
  label!: string;
}

export class CreatePlaceResponseDto {
  @ApiProperty({ type: PlaceDetailDto })
  place!: PlaceDetailDto;

  @ApiProperty({
    type: [PlaceListItemDto],
    description:
      'Nearby places with a similar name and the same category. Advisory only — the ' +
      'submission was accepted. Two restaurants sharing a name in different places are ' +
      'not duplicates.',
  })
  possibleDuplicates!: PlaceListItemDto[];
}
