import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { ErrorResponse } from '../../../common/errors/error-response.js';
import { AppConfig } from '../../../infrastructure/config/app-config.js';
import { AuthGuard } from '../../identity/presentation/guards/auth.guard.js';
import {
  DiscoverAlongRouteUseCase,
  type DiscoveryResult,
} from '../application/discover-along-route.use-case.js';
import {
  discoveryQuerySchema,
  type DiscoveryQuery,
  type DiscoveryQueryBody,
} from '../domain/discovery-query.js';
import { DiscoveryRateLimitGuard } from './guards/discovery-rate-limit.guard.js';
import { DiscoveryRequestDto, DiscoveryResponseDto } from './dto/discovery.dto.js';

/**
 * Discovery along a route (§39, §41).
 *
 * Its own path root rather than a verb hung off `/routes`, because discovery is a
 * different bounded context with a different question: routing answers *how to get
 * there*, discovery answers *what is worth considering on the way* (§67).
 *
 * Not called `recommendations`. A recommendation implies a model of the person asking,
 * and Trilha has none — no history, no preferences, no ratings to learn from. Calling
 * this endpoint a recommender would promise personalisation that does not exist and
 * would be a lie in the API contract itself (§39).
 *
 * **Authenticated**, for the same reason routing is, only more so: each call spends a
 * route calculation *and* a matrix request upstream.
 */
@ApiTags('discovery')
@ApiBearerAuth()
@Controller('discovery')
@UseGuards(AuthGuard, DiscoveryRateLimitGuard)
export class DiscoveryController {
  constructor(
    private readonly discover: DiscoverAlongRouteUseCase,
    private readonly config: AppConfig,
  ) {}

  @Post('routes')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Find Places worth considering along a route',
    description:
      'Calculates the route between two points, finds active Places within the ' +
      'corridor, measures what diverting to each would actually cost, and ranks them ' +
      'by a deterministic, versioned policy. Nothing is persisted: neither the route, ' +
      'the corridor, nor the candidates. An empty candidate list is a successful ' +
      'answer, not an error.',
  })
  @ApiBody({ type: DiscoveryRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: DiscoveryResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    type: ErrorResponse,
    description:
      'Invalid coordinates, endpoints too close or too far apart, or a malformed filter.',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ErrorResponse,
    description: 'No driving route connects the two points, so there is nothing to discover along.',
  })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, type: ErrorResponse })
  @ApiResponse({
    status: HttpStatus.BAD_GATEWAY,
    type: ErrorResponse,
    description: 'A routing or travel-cost provider is unavailable or returned an unusable result.',
  })
  @ApiResponse({ status: HttpStatus.GATEWAY_TIMEOUT, type: ErrorResponse })
  async discoverAlongRoute(
    @Body(new ZodValidationPipe(discoveryQuerySchema)) body: DiscoveryQueryBody,
  ): Promise<DiscoveryResponseDto> {
    const result = await this.discover.execute(this.resolve(body));
    return toResponseDto(result);
  }

  /**
   * Applies every server ceiling once, at the edge.
   *
   * A client may ask for a wider corridor, a longer detour or a bigger page than the
   * deployment allows; each is clamped rather than rejected, because the request is
   * still meaningful — it just cannot be granted in full. What must not happen is a
   * downstream stage having to wonder whether a bound was applied (§82, §83).
   */
  private resolve(body: DiscoveryQueryBody): DiscoveryQuery {
    const { discovery, routing } = this.config;

    const maxDetourMinutes = Math.min(
      body.maxDetourMinutes ?? discovery.defaultMaxDetourMinutes,
      discovery.maxDetourMinutes,
    );

    return {
      origin: body.origin,
      destination: body.destination,
      corridorWidthMeters: Math.min(
        body.corridorWidthMeters ?? routing.corridorDefaultMeters,
        routing.corridorMaxMeters,
      ),
      maxDetourSeconds: maxDetourMinutes * 60,
      categories: body.categories,
      limit: Math.min(body.limit ?? discovery.maxResults, discovery.maxResults),
    };
  }
}

function toResponseDto(result: DiscoveryResult): DiscoveryResponseDto {
  return {
    route: {
      distanceMeters: result.route.metrics.distanceMeters,
      durationSeconds: result.route.metrics.durationSeconds,
    },
    policyVersion: result.policyVersion,
    candidates: result.candidates.map((candidate) => ({
      place: { ...candidate.place },
      distanceFromRouteMeters: Math.round(candidate.distanceFromRouteMeters),
      detourDistanceMeters: candidate.detourDistanceMeters,
      detourDurationSeconds: candidate.detourDurationSeconds,
      /* Four decimals is finer than any UI reads it at, and keeps the wire value from
         carrying float noise that would differ between runs. */
      routeProgress: Math.round(candidate.routeProgress * 10_000) / 10_000,
      relevanceScore: candidate.relevanceScore,
      relevanceReasons: [...candidate.relevanceReasons],
    })),
    diagnostics: {
      spatialCandidates: result.diagnostics.spatialCandidates,
      evaluatedCandidates: result.diagnostics.evaluatedCandidates,
      returnedCandidates: result.diagnostics.returnedCandidates,
    },
  };
}
