import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from '../../../places/domain/coordinates.js';
import { MAX_TRAIL_STOPS, TRAIL_STOP_SOURCES } from '../../domain/trail.js';

/**
 * Transport contracts for Trails (§80, §81).
 *
 * Provider-independent throughout: nothing here names a routing supplier, and a
 * change of one would not alter a field.
 *
 * Three shapes rather than one, deliberately. `TrailSummary` has no geometry, because
 * a list of twenty trails should not ship twenty LineStrings to a phone on a mobile
 * connection; `TrailDetail` has everything the builder needs to restore itself; and a
 * mutation returns a detail, so a client never has to re-fetch to learn the revision
 * it must send next.
 */

const TRAIL_LABEL_MAX = 120;

const endpointSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Present when the endpoint came from a Place. Never required (§9). */
  placeId: z.uuid().optional(),
  label: z.string().trim().min(1).max(TRAIL_LABEL_MAX).optional(),
});

export const createTrailBodySchema = z.object({
  origin: endpointSchema,
  destination: endpointSchema,
});

export type CreateTrailBody = z.infer<typeof createTrailBodySchema>;

/**
 * The revision the client believes it is editing (§25).
 *
 * Required on every mutation, with no default. A default would let a client that has
 * never read the trail overwrite it, which is precisely the case optimistic
 * concurrency exists to prevent.
 */
const expectedRevisionSchema = z.coerce.number().int().min(1);

export const addStopBodySchema = z.object({
  placeId: z.uuid(),
  source: z.enum(TRAIL_STOP_SOURCES as [string, ...string[]]),
  expectedRevision: expectedRevisionSchema,
});

export type AddStopBody = z.infer<typeof addStopBodySchema>;

export const reorderStopsBodySchema = z.object({
  /* The whole set, in order. A partial list would leave the unnamed stops in an order
     nobody chose (§31). */
  stopIds: z.array(z.uuid()).min(1).max(MAX_TRAIL_STOPS),
  expectedRevision: expectedRevisionSchema,
});

export type ReorderStopsBody = z.infer<typeof reorderStopsBodySchema>;

export const revisionOnlyBodySchema = z.object({
  expectedRevision: expectedRevisionSchema,
});

export type RevisionOnlyBody = z.infer<typeof revisionOnlyBodySchema>;

export const patchTrailBodySchema = z
  .object({
    origin: endpointSchema.optional(),
    destination: endpointSchema.optional(),
    expectedRevision: expectedRevisionSchema,
  })
  .refine((body) => body.origin !== undefined || body.destination !== undefined, {
    message: 'Provide an origin, a destination, or both.',
  });

export type PatchTrailBody = z.infer<typeof patchTrailBodySchema>;

export const listTrailsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Opaque keyset cursor from the previous page. */
  cursor: z.string().max(200).optional(),
  status: z.enum(['DRAFT', 'FINALIZED', 'ARCHIVED']).optional(),
});

export type ListTrailsQuery = z.infer<typeof listTrailsQuerySchema>;

/* ---- OpenAPI shapes ------------------------------------------------------- */

export class TrailEndpointDto {
  @ApiProperty({ minimum: -90, maximum: 90, example: -8.0631 })
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180, example: -34.8711 })
  longitude!: number;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  placeId!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Marco Zero' })
  label!: string | null;
}

export class CreateTrailRequestDto {
  @ApiProperty({ type: TrailEndpointDto })
  origin!: TrailEndpointDto;

  @ApiProperty({ type: TrailEndpointDto })
  destination!: TrailEndpointDto;
}

export class AddStopRequestDto {
  @ApiProperty({ format: 'uuid', description: 'A stop is always a resolved Place.' })
  placeId!: string;

  @ApiProperty({
    enum: TRAIL_STOP_SOURCES,
    description:
      'Where the addition came from. Provenance of the composition, not a quality signal.',
  })
  source!: string;

  @ApiProperty({
    minimum: 1,
    example: 3,
    description:
      'The revision the client is editing. A mismatch returns 409 rather than ' +
      'overwriting whatever changed in the meantime.',
  })
  expectedRevision!: number;
}

export class ReorderStopsRequestDto {
  @ApiProperty({
    type: [String],
    maxItems: MAX_TRAIL_STOPS,
    description: 'Every stop on the trail, in the new visiting order.',
  })
  stopIds!: string[];

  @ApiProperty({ minimum: 1, example: 5 })
  expectedRevision!: number;
}

export class RevisionOnlyRequestDto {
  @ApiProperty({ minimum: 1, example: 5 })
  expectedRevision!: number;
}

export class PatchTrailRequestDto {
  @ApiPropertyOptional({ type: TrailEndpointDto })
  origin?: TrailEndpointDto;

  @ApiPropertyOptional({ type: TrailEndpointDto })
  destination?: TrailEndpointDto;

  @ApiProperty({ minimum: 1, example: 2 })
  expectedRevision!: number;
}

export class TrailStopDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  placeId!: string;

  @ApiProperty({ minimum: 1, description: '1-based visiting order, contiguous.' })
  position!: number;

  @ApiProperty({ enum: TRAIL_STOP_SOURCES })
  source!: string;

  @ApiProperty({ example: 'Mirante do Alto da Sé' })
  placeName!: string;

  @ApiProperty({ example: 'LANDMARK' })
  placeCategoryId!: string;

  @ApiProperty({ example: -7.9939 })
  latitude!: number;

  @ApiProperty({ example: -34.8455 })
  longitude!: number;
}

export class TrailGeometryDto {
  @ApiProperty({ enum: ['LineString'] })
  type!: 'LineString';

  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    description: 'GeoJSON positions as [longitude, latitude].',
  })
  coordinates!: number[][];
}

export class TrailBoundsDto {
  @ApiProperty() north!: number;
  @ApiProperty() south!: number;
  @ApiProperty() east!: number;
  @ApiProperty() west!: number;
}

export class TrailRouteSnapshotDto {
  @ApiProperty({ type: TrailGeometryDto })
  geometry!: TrailGeometryDto;

  @ApiProperty({ type: TrailBoundsDto })
  bounds!: TrailBoundsDto;

  @ApiProperty({ example: 145_000 })
  distanceMeters!: number;

  @ApiProperty({ example: 7_860 })
  durationSeconds!: number;

  /* The provider that computed this is recorded in the database for support, and
     deliberately not published. A client has no use for it, and putting a supplier's
     name in the contract — even as an example — is how a contract stops being
     provider-independent (§20, §81). */

  @ApiProperty({ format: 'date-time' })
  calculatedAt!: string;

  @ApiProperty({
    example: 7,
    description:
      'The trail revision this route describes. Equal to the trail revision means current.',
  })
  revision!: number;
}

export class TrailBaseRouteDto {
  @ApiProperty({ example: 121_000 })
  distanceMeters!: number;

  @ApiProperty({ example: 6_480 })
  durationSeconds!: number;

  @ApiProperty({ format: 'date-time' })
  calculatedAt!: string;
}

export class TrailDetourDto {
  @ApiProperty({ example: 24_000 })
  extraDistanceMeters!: number;

  @ApiProperty({ example: 1_380 })
  extraDurationSeconds!: number;
}

export class TrailDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'FINALIZED', 'ARCHIVED'] })
  status!: string;

  @ApiProperty({ type: TrailEndpointDto })
  origin!: TrailEndpointDto;

  @ApiProperty({ type: TrailEndpointDto })
  destination!: TrailEndpointDto;

  @ApiProperty({ type: [TrailStopDto] })
  stops!: TrailStopDto[];

  @ApiProperty({
    example: 7,
    description: 'Send this back as expectedRevision on the next mutation.',
  })
  revision!: number;

  @ApiProperty({ type: TrailRouteSnapshotDto, nullable: true })
  route!: TrailRouteSnapshotDto | null;

  @ApiProperty({ type: TrailBaseRouteDto, nullable: true })
  baseRoute!: TrailBaseRouteDto | null;

  @ApiProperty({
    type: TrailDetourDto,
    nullable: true,
    description:
      'What the stops add over the same endpoints with none. Null when either ' +
      'snapshot is missing — "not measured" is not the same claim as "no detour".',
  })
  detour!: TrailDetourDto | null;

  @ApiProperty({
    description: 'Whether the stored route describes the composition as it now stands.',
  })
  routeIsCurrent!: boolean;

  @ApiProperty({ example: MAX_TRAIL_STOPS, description: 'Server ceiling on stops.' })
  maxStops!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  finalizedAt!: string | null;
}

export class TrailSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['DRAFT', 'FINALIZED', 'ARCHIVED'] })
  status!: string;

  @ApiProperty({ nullable: true, type: String })
  originLabel!: string | null;

  @ApiProperty({ nullable: true, type: String })
  destinationLabel!: string | null;

  @ApiProperty({ example: 3 })
  stopCount!: number;

  @ApiProperty({ nullable: true, type: Number, example: 145_000 })
  distanceMeters!: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 7_860 })
  durationSeconds!: number | null;

  @ApiProperty({ example: 7 })
  revision!: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class TrailListResponseDto {
  @ApiProperty({ type: [TrailSummaryDto] })
  trails!: TrailSummaryDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Pass as `cursor` for the next page. Null on the last page.',
  })
  nextCursor!: string | null;
}
