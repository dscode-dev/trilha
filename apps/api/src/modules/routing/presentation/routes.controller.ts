import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { ErrorResponse } from '../../../common/errors/error-response.js';
import { AuthGuard } from '../../identity/presentation/guards/auth.guard.js';
import { CalculateRouteUseCase } from '../application/calculate-route.use-case.js';
import type { Route } from '../domain/route.js';
import { RoutingRateLimitGuard } from './guards/routing-rate-limit.guard.js';
import {
  CalculateRouteRequestDto,
  RouteResponseDto,
  calculateRouteBodySchema,
  type CalculateRouteRequest,
} from './dto/route.dto.js';

/**
 * Route calculation (§25, §26).
 *
 * **Authenticated.** Places reads are public because they are served from Trilha's own
 * database and cost nothing to answer. Routing is different: every call is a billed
 * request to a third party, so an open endpoint would be a free proxy to a metered
 * API — abusable by anyone who finds the URL. Requiring a session makes consumption
 * attributable and gives the rate limiter a stable subject.
 */
@ApiTags('routing')
@ApiBearerAuth()
@Controller('routes')
@UseGuards(AuthGuard, RoutingRateLimitGuard)
export class RoutesController {
  constructor(private readonly calculateRoute: CalculateRouteUseCase) {}

  @Post('calculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate a driving route',
    description:
      'Returns a normalised route between two points: GeoJSON geometry, distance in ' +
      'metres, duration in seconds, bounds computed from the geometry, and legs. ' +
      'Driving only in V1. Nothing is persisted — a route is a computation, not a ' +
      'record.',
  })
  @ApiBody({ type: CalculateRouteRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: RouteResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    type: ErrorResponse,
    description: 'Invalid coordinates, or endpoints too close together or too far apart.',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ErrorResponse,
    description: 'No driving route connects the two points.',
  })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, type: ErrorResponse })
  @ApiResponse({
    status: HttpStatus.BAD_GATEWAY,
    type: ErrorResponse,
    description: 'The routing provider is unavailable or returned an unusable result.',
  })
  @ApiResponse({
    status: HttpStatus.GATEWAY_TIMEOUT,
    type: ErrorResponse,
    description: 'The routing provider exceeded its deadline.',
  })
  async calculate(
    @Body(new ZodValidationPipe(calculateRouteBodySchema)) body: CalculateRouteRequest,
  ): Promise<RouteResponseDto> {
    const route = await this.calculateRoute.execute({
      origin: body.origin,
      destination: body.destination,
      corridorWidthMeters: body.corridorWidthMeters,
      includeCorridor: body.includeCorridor,
    });

    return toResponseDto(route);
  }
}

/** `exactOptionalPropertyTypes` forbids an explicit `undefined`; omit instead. */
function toEndpointDto(point: Route['origin']): RouteResponseDto['origin'] {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    ...(point.placeId === undefined ? {} : { placeId: point.placeId }),
  };
}

function toResponseDto(route: Route): RouteResponseDto {
  return {
    origin: toEndpointDto(route.origin),
    destination: toEndpointDto(route.destination),
    geometry: {
      type: route.geometry.type,
      coordinates: route.geometry.coordinates.map(([lng, lat]) => [lng, lat]),
    },
    distanceMeters: route.metrics.distanceMeters,
    durationSeconds: route.metrics.durationSeconds,
    bounds: { ...route.bounds },
    legs: route.legs.map((leg) => ({ ...leg })),
    corridor:
      route.corridor === null
        ? null
        : {
            widthMeters: route.corridor.widthMeters,
            geometry: route.corridor.geometry as Record<string, unknown>,
          },
  };
}
