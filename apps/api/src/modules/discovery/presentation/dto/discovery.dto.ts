import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RELEVANCE_REASONS } from '../../domain/route-candidate.js';
import { MAX_CATEGORY_FILTERS } from '../../domain/discovery-query.js';

/**
 * Transport contracts for discovery (§40, §81).
 *
 * Provider-independent throughout: nothing here names a vendor, and neither the
 * matrix nor the directions engine is visible in the shape a client sees.
 */

export class DiscoveryEndpointDto {
  @ApiProperty({ minimum: -90, maximum: 90, example: -8.0631 })
  latitude!: number;

  @ApiProperty({ minimum: -180, maximum: 180, example: -34.8711 })
  longitude!: number;

  @ApiPropertyOptional({ format: 'uuid' })
  placeId?: string;
}

export class DiscoveryRequestDto {
  @ApiProperty({ type: DiscoveryEndpointDto })
  origin!: DiscoveryEndpointDto;

  @ApiProperty({ type: DiscoveryEndpointDto })
  destination!: DiscoveryEndpointDto;

  @ApiPropertyOptional({
    minimum: 100,
    maximum: 50_000,
    example: 5_000,
    description:
      'Half-width of the search corridor in metres. Clamped to the server maximum. ' +
      'A Place outside it is never considered, however small its detour would be.',
  })
  corridorWidthMeters?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 600,
    example: 30,
    description:
      'Longest acceptable diversion. Candidates costing more are discarded, not ' +
      'ranked lower. Clamped to the server maximum.',
  })
  maxDetourMinutes?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_CATEGORY_FILTERS,
    example: ['NATURE', 'FOOD'],
    description: 'Place category ids. Empty or absent means every category is eligible.',
  })
  categories?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 100, example: 20 })
  limit?: number;
}

export class CandidatePlaceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Mirante do Alto da Sé' })
  name!: string;

  @ApiProperty({ example: 'LANDMARK' })
  categoryId!: string;

  @ApiProperty({ example: -7.9939 })
  latitude!: number;

  @ApiProperty({ example: -34.8455 })
  longitude!: number;

  @ApiProperty({
    enum: ['COMMUNITY', 'SYSTEM'],
    description:
      'Where the Place came from. Informational only — it does not affect ranking, ' +
      'because origin is not quality.',
  })
  provenance!: string;
}

export class RouteCandidateDto {
  @ApiProperty({ type: CandidatePlaceDto })
  place!: CandidatePlaceDto;

  @ApiProperty({
    example: 1_200,
    description: 'Shortest distance from the Place to the route line, on the spheroid.',
  })
  distanceFromRouteMeters!: number;

  @ApiProperty({
    example: 3_400,
    description:
      'Extra road distance from routing via this Place, against the same provider’s ' +
      'own direct journey. Not the same as distanceFromRouteMeters.',
  })
  detourDistanceMeters!: number;

  @ApiProperty({ example: 420, description: 'Extra travel time from the diversion.' })
  detourDurationSeconds!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    example: 0.42,
    description: 'Where along the journey the Place sits: 0 at the origin, 1 at the destination.',
  })
  routeProgress!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1,
    example: 0.91,
    description:
      'How well this Place fits this route, under the named policy. Not a quality ' +
      'rating and not comparable across policy versions.',
  })
  relevanceScore!: number;

  @ApiProperty({
    isArray: true,
    enum: RELEVANCE_REASONS,
    example: ['VERY_CLOSE_TO_ROUTE', 'LOW_DETOUR', 'GOOD_ROUTE_POSITION'],
    description: 'Machine-readable codes. Clients own the wording shown to a user.',
  })
  relevanceReasons!: string[];
}

export class DiscoveryRouteSummaryDto {
  @ApiProperty({ example: 121_000 })
  distanceMeters!: number;

  @ApiProperty({ example: 6_480 })
  durationSeconds!: number;
}

export class DiscoveryDiagnosticsDto {
  @ApiProperty({
    example: 37,
    description: 'Places the spatial query returned, after cheap filters.',
  })
  spatialCandidates!: number;

  @ApiProperty({ example: 20, description: 'Of those, how many had a detour measured.' })
  evaluatedCandidates!: number;

  @ApiProperty({
    example: 12,
    description: 'How many survived the detour ceiling and were returned.',
  })
  returnedCandidates!: number;
}

export class DiscoveryResponseDto {
  @ApiProperty({
    type: DiscoveryRouteSummaryDto,
    description: 'The base journey the candidates are measured against.',
  })
  route!: DiscoveryRouteSummaryDto;

  @ApiProperty({
    example: 'v1',
    description:
      'Which ranking policy produced this order. Scores from different versions are ' +
      'not comparable.',
  })
  policyVersion!: string;

  @ApiProperty({ type: [RouteCandidateDto] })
  candidates!: RouteCandidateDto[];

  @ApiProperty({ type: DiscoveryDiagnosticsDto })
  diagnostics!: DiscoveryDiagnosticsDto;
}
