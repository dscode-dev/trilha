import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';
import { ErrorResponse } from '../../../common/errors/error-response.js';
import { getRequestId } from '../../../common/http/request-context.js';
import { AuthGuard } from '../../identity/presentation/guards/auth.guard.js';
import { CurrentUser } from '../../identity/presentation/guards/current-user.decorator.js';
import type { AuthenticatedPrincipal } from '../../identity/presentation/guards/authenticated-request.js';
import { CreatePlaceUseCase } from '../application/create-place.use-case.js';
import { QueryPlacesUseCase } from '../application/query-places.use-case.js';
import type { PlaceDetail, PlaceListItem } from '../domain/place.js';
import {
  CreatePlaceRequestDto,
  CreatePlaceResponseDto,
  PlaceCategoryDto,
  PlaceDetailDto,
  PlaceListItemDto,
  PlaceMapResponseDto,
  PlacePageDto,
  createPlaceSchema,
  mapQuerySchema,
  nearbyQuerySchema,
  searchQuerySchema,
  type CreatePlaceBody,
  type MapQuery,
  type NearbyQuery,
  type SearchQuery,
} from './dto/place.dto.js';

/**
 * Places transport.
 *
 * **Reads are public, writes require a session (§33).** Trilha is a geographic
 * discovery product: requiring an account to look at the map would mean a first-time
 * visitor sees nothing, which defeats the point. Contributing is where identity
 * starts to matter, so that is where the guard sits.
 */
@ApiTags('places')
@Controller('places')
export class PlacesController {
  constructor(
    private readonly createPlace: CreatePlaceUseCase,
    private readonly queryPlaces: QueryPlacesUseCase,
  ) {}

  @Get('categories')
  @ApiOperation({
    summary: 'List place categories',
    description: 'The fixed vocabulary a place can be filed under. Public.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [PlaceCategoryDto] })
  async categories(): Promise<PlaceCategoryDto[]> {
    return this.queryPlaces.categories();
  }

  @Get('map')
  @ApiOperation({
    summary: 'Places inside a viewport',
    description:
      'The map query. Returns only what a marker needs — id, name, category and ' +
      'position — so a pan does not transfer descriptions nobody is reading. ' +
      'Viewports crossing the antimeridian are rejected; see the error message.',
  })
  @ApiQuery({ name: 'north', example: -8.0 })
  @ApiQuery({ name: 'south', example: -8.1 })
  @ApiQuery({ name: 'east', example: -34.8 })
  @ApiQuery({ name: 'west', example: -34.9 })
  @ApiResponse({ status: HttpStatus.OK, type: PlaceMapResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, type: ErrorResponse })
  async map(
    @Query(new ZodValidationPipe(mapQuerySchema)) query: MapQuery,
  ): Promise<PlaceMapResponseDto> {
    return this.queryPlaces.map(query);
  }

  @Get('nearby')
  @ApiOperation({
    summary: 'Places within a radius',
    description: 'Nearest first. Distances are metres on the spheroid, not degrees.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: PlacePageDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, type: ErrorResponse })
  async nearby(
    @Query(new ZodValidationPipe(nearbyQuerySchema)) query: NearbyQuery,
  ): Promise<PlacePageDto> {
    const page = await this.queryPlaces.nearby({
      coordinates: { latitude: query.lat, longitude: query.lng },
      radiusMetres: query.radiusMeters,
      categoryId: query.categoryId,
      limit: query.limit,
      offset: query.offset,
    });

    return { ...page, items: page.items.map(toListItemDto) };
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search places by name',
    description:
      'Accent- and case-insensitive: "sao paulo" matches "São Paulo". Supply lat/lng ' +
      'to order results by proximity and receive distances.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: PlacePageDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, type: ErrorResponse })
  async search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<PlacePageDto> {
    const near =
      query.lat === undefined || query.lng === undefined
        ? undefined
        : { latitude: query.lat, longitude: query.lng };

    const page = await this.queryPlaces.search({
      term: query.q,
      categoryId: query.categoryId,
      near,
      limit: query.limit,
      offset: query.offset,
    });

    return { ...page, items: page.items.map(toListItemDto) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one place', description: 'Public. Archived places are hidden.' })
  @ApiResponse({ status: HttpStatus.OK, type: PlaceDetailDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, type: ErrorResponse })
  async byId(@Param('id') id: string): Promise<PlaceDetailDto> {
    return toDetailDto(await this.queryPlaces.byId(id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Contribute a place',
    description:
      'Requires a session. Provenance, status and authorship are decided by the ' +
      'server and ignored if sent. The response may carry advisory near-duplicates.',
  })
  @ApiBody({ type: CreatePlaceRequestDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreatePlaceResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, type: ErrorResponse })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponse })
  async create(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createPlaceSchema)) body: CreatePlaceBody,
  ): Promise<CreatePlaceResponseDto> {
    const { placeId, possibleDuplicates } = await this.createPlace.execute({
      name: body.name,
      categoryId: body.categoryId,
      coordinates: { latitude: body.latitude, longitude: body.longitude },
      description: body.description ?? null,
      userId: principal.userId,
      requestId: getRequestId() ?? null,
    });

    return {
      place: toDetailDto(await this.queryPlaces.byId(placeId)),
      possibleDuplicates: possibleDuplicates.map(toListItemDto),
    };
  }
}

function toListItemDto(item: PlaceListItem): PlaceListItemDto {
  return {
    id: item.id,
    name: item.name,
    categoryId: item.categoryId,
    latitude: item.latitude,
    longitude: item.longitude,
    description: item.description,
    distanceMetres: item.distanceMetres,
  };
}

function toDetailDto(place: PlaceDetail): PlaceDetailDto {
  return {
    id: place.id,
    name: place.name,
    categoryId: place.categoryId,
    latitude: place.latitude,
    longitude: place.longitude,
    description: place.description,
    provenance: place.provenance,
    status: place.status,
    createdAt: place.createdAt.toISOString(),
    updatedAt: place.updatedAt.toISOString(),
    contributor: place.contributor === null ? null : { ...place.contributor },
  };
}
