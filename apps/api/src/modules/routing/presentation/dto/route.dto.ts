import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { calculateRouteSchema } from '../../domain/route-request.js';

/**
 * Transport contracts for routing (§25, §50).
 *
 * Provider-independent throughout: nothing here names Mapbox, and a change of
 * supplier would not alter a single field.
 */

export const calculateRouteBodySchema = calculateRouteSchema.extend({
  /** Half-width of the corridor in metres. Clamped server-side to the configured max. */
  corridorWidthMeters: z.coerce.number().int().min(100).max(50_000).optional(),
  /**
   * The corridor is a polygon the client does not draw, so it is opt-in rather than
   * always shipped (§47). PR-04 consumes it server-side.
   */
  includeCorridor: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .default(false),
});

export type CalculateRouteRequest = z.infer<typeof calculateRouteBodySchema>;

/* ---- OpenAPI shapes ------------------------------------------------------- */

export class RouteEndpointDto {
  @ApiProperty({ minimum: -90, maximum: 90, example: -8.0631 })
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180, example: -34.8711 })
  longitude!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Set when this endpoint came from a Place. Routing never requires one.',
  })
  placeId?: string;
}

export class CalculateRouteRequestDto {
  @ApiProperty({ type: RouteEndpointDto })
  origin!: RouteEndpointDto;

  @ApiProperty({ type: RouteEndpointDto })
  destination!: RouteEndpointDto;

  @ApiPropertyOptional({
    minimum: 100,
    maximum: 50_000,
    description: 'Corridor half-width in metres. Clamped to the server maximum.',
    example: 5_000,
  })
  corridorWidthMeters?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Return the corridor polygon. Off by default: it is a large geometry that ' +
      'clients do not draw.',
  })
  includeCorridor?: boolean;
}

export class RouteGeometryDto {
  @ApiProperty({ enum: ['LineString'], example: 'LineString' })
  type!: 'LineString';

  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    description: 'GeoJSON positions as [longitude, latitude] — GeoJSON axis order.',
    example: [
      [-34.8711, -8.0631],
      [-34.8631, -7.115],
    ],
  })
  coordinates!: number[][];
}

export class RouteBoundsDto {
  @ApiProperty({ example: -7.115 })
  north!: number;

  @ApiProperty({ example: -8.0631 })
  south!: number;

  @ApiProperty({ example: -34.8631 })
  east!: number;

  @ApiProperty({ example: -34.8711 })
  west!: number;
}

export class RouteLegDto {
  @ApiProperty({ example: 105_060 })
  distanceMeters!: number;

  @ApiProperty({ example: 6_480 })
  durationSeconds!: number;

  @ApiProperty({ nullable: true, type: String, example: 'BR-101' })
  summary!: string | null;
}

export class RouteCorridorDto {
  @ApiProperty({ example: 5_000 })
  widthMeters!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'GeoJSON Polygon or MultiPolygon covering the area around the route.',
  })
  geometry!: Record<string, unknown>;
}

export class RouteResponseDto {
  @ApiProperty({ type: RouteEndpointDto })
  origin!: RouteEndpointDto;

  @ApiProperty({ type: RouteEndpointDto })
  destination!: RouteEndpointDto;

  @ApiProperty({ type: RouteGeometryDto })
  geometry!: RouteGeometryDto;

  @ApiProperty({ example: 105_060, description: 'Road distance in metres.' })
  distanceMeters!: number;

  @ApiProperty({ example: 6_480, description: 'Estimated driving time in seconds.' })
  durationSeconds!: number;

  @ApiProperty({ type: RouteBoundsDto })
  bounds!: RouteBoundsDto;

  @ApiProperty({ type: [RouteLegDto] })
  legs!: RouteLegDto[];

  @ApiProperty({
    type: RouteCorridorDto,
    nullable: true,
    description: 'Present only when includeCorridor was requested.',
  })
  corridor!: RouteCorridorDto | null;
}
