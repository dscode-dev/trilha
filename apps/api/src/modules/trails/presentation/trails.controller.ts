import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { ErrorResponse } from '../../../common/errors/error-response.js';
import { AuthGuard } from '../../identity/presentation/guards/auth.guard.js';
import { CurrentUser } from '../../identity/presentation/guards/current-user.decorator.js';
import type { AuthenticatedPrincipal } from '../../identity/presentation/guards/authenticated-request.js';
import { TrailBuilderService } from '../application/trail-builder.service.js';
import {
  MAX_TRAIL_STOPS,
  isRouteCurrent,
  trailDetour,
  type Trail,
  type TrailStopSource,
  type TrailSummary,
} from '../domain/trail.js';
import { TrailMutationRateLimitGuard } from './guards/trail-mutation-rate-limit.guard.js';
import {
  AddStopRequestDto,
  CreateTrailRequestDto,
  PatchTrailRequestDto,
  ReorderStopsRequestDto,
  RevisionOnlyRequestDto,
  TrailDetailDto,
  TrailListResponseDto,
  TrailSummaryDto,
  addStopBodySchema,
  createTrailBodySchema,
  listTrailsQuerySchema,
  patchTrailBodySchema,
  reorderStopsBodySchema,
  revisionOnlyBodySchema,
  type AddStopBody,
  type CreateTrailBody,
  type ListTrailsQuery,
  type PatchTrailBody,
  type ReorderStopsBody,
  type RevisionOnlyBody,
} from './dto/trail.dto.js';

/**
 * The Trail Builder API (§53, §79).
 *
 * **Every route is authenticated and owner-scoped**, and ownership is resolved from
 * the session rather than from anything the client sends. A `userId` in a body or a
 * query string would be a request to edit someone else's trail, and there is no
 * version of trusting it that is safe.
 *
 * Mutations additionally pass a rate limiter, because each one spends a routing call.
 * Reads do not: they are served from Trilha's own database and cost nothing upstream.
 */
@ApiTags('trails')
@ApiBearerAuth()
@Controller('trails')
@UseGuards(AuthGuard)
export class TrailsController {
  constructor(private readonly builder: TrailBuilderService) {}

  @Post()
  @UseGuards(TrailMutationRateLimitGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a trail between two points',
    description:
      'Creates a draft and routes it in the same call. If the routing provider is ' +
      'unavailable the trail is still created without a route snapshot — a draft the ' +
      'user can return to is worth more than an error that loses their two points. ' +
      '`routeIsCurrent` says which happened.',
  })
  @ApiBody({ type: CreateTrailRequestDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: TrailDetailDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, type: ErrorResponse })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  @ApiResponse({ status: HttpStatus.TOO_MANY_REQUESTS, type: ErrorResponse })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createTrailBodySchema)) body: CreateTrailBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.create({
      ownerUserId: principal.userId,
      origin: body.origin,
      destination: body.destination,
    });

    return toDetailDto(trail);
  }

  @Get()
  @ApiOperation({
    summary: 'List my trails',
    description:
      'Newest first, keyset-paginated. Summaries only — a list of trails must not ' +
      'ship a LineString per row to a phone.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: TrailListResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(new ZodValidationPipe(listTrailsQuerySchema)) query: ListTrailsQuery,
  ): Promise<TrailListResponseDto> {
    const trails = await this.builder.listForOwner({
      ownerUserId: principal.userId,
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
      statuses: query.status === undefined ? undefined : [query.status],
    });

    const last = trails.at(-1);

    return {
      trails: trails.map(toSummaryDto),
      /* A cursor only when the page was full: a short page is the last one, and
         offering a cursor there invites a pointless extra request. */
      nextCursor: trails.length === query.limit && last !== undefined ? encodeCursor(last) : null,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one trail',
    description:
      'Everything the builder needs to restore itself from cold: endpoints, ordered ' +
      'stops, the route snapshot, and the revision to send with the next mutation.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    type: ErrorResponse,
    description: 'No such trail, or it belongs to someone else — deliberately the same answer.',
  })
  async detail(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TrailDetailDto> {
    return toDetailDto(await this.builder.getForOwner(id, principal.userId));
  }

  @Patch(':id')
  @UseGuards(TrailMutationRateLimitGuard)
  @ApiOperation({
    summary: 'Change a trail’s endpoints',
    description: 'Re-routes the whole composition and recomputes the A → B baseline.',
  })
  @ApiBody({ type: PatchTrailRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ErrorResponse,
    description: 'Revision conflict.',
  })
  async patch(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(patchTrailBodySchema)) body: PatchTrailBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.updateEndpoints({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
      origin: body.origin,
      destination: body.destination,
    });

    return toDetailDto(trail);
  }

  @Post(':id/stops')
  @UseGuards(TrailMutationRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a stop',
    description:
      'A stop is always a resolved Place. The trail is re-routed through it, in ' +
      'position, before anything is written: if routing fails, nothing changes.',
  })
  @ApiBody({ type: AddStopRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ErrorResponse,
    description: 'Revision conflict, or that place is already a stop.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ErrorResponse,
    description: 'Stop limit reached, or the place cannot be added.',
  })
  @ApiResponse({ status: HttpStatus.BAD_GATEWAY, type: ErrorResponse })
  async addStop(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(addStopBodySchema)) body: AddStopBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.addStop({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
      placeId: body.placeId,
      source: body.source as TrailStopSource,
    });

    return toDetailDto(trail);
  }

  @Delete(':id/stops/:stopId')
  @UseGuards(TrailMutationRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a stop', description: 'Closes the gap and re-routes.' })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  async removeStop(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body(new ZodValidationPipe(revisionOnlyBodySchema)) body: RevisionOnlyBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.removeStop({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
      stopId,
    });

    return toDetailDto(trail);
  }

  @Put(':id/stops/order')
  @UseGuards(TrailMutationRateLimitGuard)
  @ApiOperation({
    summary: 'Reorder stops',
    description:
      'Takes the whole set in the new order. One call per completed drag — not one ' +
      'per frame — and one recalculation.',
  })
  @ApiBody({ type: ReorderStopsRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    type: ErrorResponse,
    description: 'The order omits a stop, repeats one, or names one from another trail.',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  async reorder(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reorderStopsBodySchema)) body: ReorderStopsBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.reorderStops({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
      orderedStopIds: body.stopIds,
    });

    return toDetailDto(trail);
  }

  @Post(':id/recalculate')
  @UseGuards(TrailMutationRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh the route',
    description:
      'Re-asks the provider for the same composition, and refreshes the baseline with it.',
  })
  @ApiBody({ type: RevisionOnlyRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  async recalculate(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(revisionOnlyBodySchema)) body: RevisionOnlyBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.recalculate({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
    });

    return toDetailDto(trail);
  }

  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a trail finished',
    description:
      'Says the user is done composing. **Not publication** — nobody else can see a ' +
      'trail. Requires a route that matches the current composition. Editing a ' +
      'finalized trail returns it to DRAFT.',
  })
  @ApiBody({ type: RevisionOnlyRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ErrorResponse,
    description: 'The route does not describe the current composition.',
  })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  async finalize(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(revisionOnlyBodySchema)) body: RevisionOnlyBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.finalize({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
    });

    return toDetailDto(trail);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a trail',
    description: 'Keeps it, stops listing it by default. The reversible alternative to deleting.',
  })
  @ApiBody({ type: RevisionOnlyRequestDto })
  @ApiResponse({ status: HttpStatus.OK, type: TrailDetailDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, type: ErrorResponse })
  async archive(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(revisionOnlyBodySchema)) body: RevisionOnlyBody,
  ): Promise<TrailDetailDto> {
    const trail = await this.builder.archive({
      trailId: id,
      ownerUserId: principal.userId,
      expectedRevision: body.expectedRevision,
    });

    return toDetailDto(trail);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a trail',
    description:
      'Permanent, along with its stops. Acceptable because nothing else references a ' +
      'trail yet — no saves, no shares, no comments.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ErrorResponse })
  async remove(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.builder.delete({ trailId: id, ownerUserId: principal.userId });
  }
}

function toDetailDto(trail: Trail): TrailDetailDto {
  const detour = trailDetour(trail);

  return {
    id: trail.id,
    status: trail.status,
    origin: { ...trail.origin },
    destination: { ...trail.destination },
    stops: trail.stops.map((stop) => ({
      id: stop.id,
      placeId: stop.placeId,
      position: stop.position,
      source: stop.source,
      placeName: stop.placeName,
      placeCategoryId: stop.placeCategoryId,
      latitude: stop.placeLatitude,
      longitude: stop.placeLongitude,
    })),
    revision: trail.revision,
    route:
      trail.route === null
        ? null
        : {
            geometry: {
              type: trail.route.geometry.type,
              coordinates: trail.route.geometry.coordinates.map(([lng, lat]) => [lng, lat]),
            },
            bounds: { ...trail.route.bounds },
            distanceMeters: trail.route.distanceMeters,
            durationSeconds: trail.route.durationSeconds,
            calculatedAt: trail.route.calculatedAt.toISOString(),
            revision: trail.route.revision,
          },
    baseRoute:
      trail.baseRoute === null
        ? null
        : {
            distanceMeters: trail.baseRoute.distanceMeters,
            durationSeconds: trail.baseRoute.durationSeconds,
            calculatedAt: trail.baseRoute.calculatedAt.toISOString(),
          },
    detour,
    routeIsCurrent: isRouteCurrent(trail),
    maxStops: MAX_TRAIL_STOPS,
    createdAt: trail.createdAt.toISOString(),
    updatedAt: trail.updatedAt.toISOString(),
    finalizedAt: trail.finalizedAt === null ? null : trail.finalizedAt.toISOString(),
  };
}

function toSummaryDto(trail: TrailSummary): TrailSummaryDto {
  return {
    id: trail.id,
    status: trail.status,
    originLabel: trail.originLabel,
    destinationLabel: trail.destinationLabel,
    stopCount: trail.stopCount,
    distanceMeters: trail.distanceMeters,
    durationSeconds: trail.durationSeconds,
    revision: trail.revision,
    updatedAt: trail.updatedAt.toISOString(),
  };
}

/**
 * Keyset cursor over `(updated_at, id)`.
 *
 * Base64 of a compound key rather than an offset: a trail edited while the user pages
 * would shift every row after it, showing one twice and hiding another. Opaque to the
 * client so the pagination key can change without breaking one.
 */
function encodeCursor(trail: TrailSummary): string {
  return Buffer.from(`${trail.updatedAt.toISOString()}|${trail.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } | undefined {
  if (cursor === undefined) return undefined;

  const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (timestamp === undefined || id === undefined) return undefined;

  const updatedAt = new Date(timestamp);
  /* A malformed cursor returns the first page rather than an error: it is an opaque
     token the client did not author, and failing the request teaches nobody anything. */
  if (Number.isNaN(updatedAt.getTime())) return undefined;

  return { updatedAt, id };
}
