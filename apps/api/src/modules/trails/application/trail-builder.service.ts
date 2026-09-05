import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CalculateRouteUseCase } from '../../routing/application/calculate-route.use-case.js';
import { PlaceLookupQuery } from '../../places/application/place-lookup.query.js';
import {
  DuplicateTrailStopError,
  InvalidStopOrderError,
  TrailNotFoundError,
  TrailRevisionConflictError,
  TrailRouteStaleError,
  TrailStopLimitError,
  TrailStopPlaceUnavailableError,
} from '../domain/trail-errors.js';
import {
  MAX_TRAIL_STOPS,
  TrailStatus,
  isRouteCurrent,
  type Trail,
  type TrailEndpoint,
  type TrailStop,
  type TrailStopSource,
  type TrailSummary,
} from '../domain/trail.js';
import {
  TrailRepository,
  type BaseRouteRecord,
  type RouteSnapshotRecord,
  type TrailEndpointInput,
  type TransactionLike,
} from '../infrastructure/trail.repository.js';
import {
  currentComposition,
  endpointToPoint,
  endpointsChanged,
  waypointsOf,
  withEndpoints,
  withStopAppended,
  withStopRemoved,
  withStopsReordered,
  type ProposedComposition,
} from './trail-composition.js';

/**
 * The Trail Builder (§27–§32, §83).
 *
 * Every composition change follows the same four steps, and the order is the whole
 * correctness argument:
 *
 * ```
 * 1. read      the Trail, scoped to its owner, and check the revision
 * 2. propose   the composition it would have, in memory
 * 3. route     ask the provider what that composition costs   ← no transaction open
 * 4. commit    one short transaction: compare-and-set the revision, apply, snapshot
 * ```
 *
 * **Step 3 is outside any transaction** (§29, §82). Holding a PostgreSQL transaction
 * open across an HTTP call to Mapbox would pin a connection for however long the
 * provider takes, and a slow upstream would exhaust the pool rather than merely be
 * slow.
 *
 * **Step 4 re-checks the revision** even though step 1 did. The provider call takes
 * time, and another request can commit during it; the compare-and-set in the UPDATE is
 * what turns that race into a 409 instead of a lost update (§25, §90).
 *
 * **A failed route means no write at all** (§83, §92). The mutation and the snapshot
 * that describes it are written together or not written: a Trail carrying a stop with
 * no route for it would show a line that omits somewhere the user chose to go.
 */
@Injectable()
export class TrailBuilderService {
  constructor(
    private readonly trails: TrailRepository,
    private readonly places: PlaceLookupQuery,
    private readonly calculateRoute: CalculateRouteUseCase,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TrailBuilderService.name);
  }

  /* ---- Reads --------------------------------------------------------------- */

  async getForOwner(trailId: string, ownerUserId: string): Promise<Trail> {
    const trail = await this.trails.findByIdForOwner(trailId, ownerUserId);
    /* Not found and not yours are the same answer: a 403 would confirm the id is
       real, which turns enumeration into a census of other people's trails (§53). */
    if (trail === undefined) throw new TrailNotFoundError();
    return trail;
  }

  async listForOwner(params: {
    ownerUserId: string;
    limit: number;
    cursor?: { updatedAt: Date; id: string } | undefined;
    statuses?: readonly TrailStatus[] | undefined;
  }): Promise<TrailSummary[]> {
    return this.trails.listForOwner(params);
  }

  /* ---- Creation ------------------------------------------------------------ */

  /**
   * Creates a Trail and routes it in one step (§26).
   *
   * If the provider is unavailable the Trail is still created, with no snapshot. A
   * draft the user can come back to is worth more than an error that loses the two
   * points they just chose — and the missing snapshot is visible (`routeIsCurrent`
   * false), so no screen has to guess.
   */
  async create(params: {
    ownerUserId: string;
    origin: TrailEndpointInput;
    destination: TrailEndpointInput;
  }): Promise<Trail> {
    const trailId = await this.trails.create({
      ownerUserId: params.ownerUserId,
      origin: params.origin,
      destination: params.destination,
    });

    try {
      const route = await this.route({
        origin: toEndpoint(params.origin),
        destination: toEndpoint(params.destination),
        stops: [],
      });

      /* With no stops the composed route *is* the base route — one provider call
         answers both questions. */
      await this.trails.attachInitialRoute({
        trailId,
        route,
        baseRoute: {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
        },
      });
    } catch (error) {
      this.logger.warn(
        { event: 'trail.created.route_unavailable', reason: errorName(error) },
        'Trail created without an initial route',
      );
    }

    this.logger.info({ event: 'trail.created' }, 'Trail created');
    return this.getForOwner(trailId, params.ownerUserId);
  }

  /* ---- Composition mutations ---------------------------------------------- */

  async addStop(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
    placeId: string;
    source: TrailStopSource;
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);

    if (trail.stops.length >= MAX_TRAIL_STOPS) throw new TrailStopLimitError(MAX_TRAIL_STOPS);
    if (trail.stops.some((stop) => stop.placeId === params.placeId)) {
      /* Also enforced by `trail_stops_trail_place_unique`; checked here so a caller
         gets a clear answer rather than a constraint violation (§33). */
      throw new DuplicateTrailStopError();
    }

    const place = await this.places.byId(params.placeId);
    /* An archived Place stays on a Trail that already has it (§51), but must not be
       added to a new one: it is no longer something Trilha shows to readers. */
    if (place?.isVisible !== true) throw new TrailStopPlaceUnavailableError();

    const proposed = withStopAppended(trail, {
      placeId: place.id,
      source: params.source,
      placeName: place.name,
      placeCategoryId: place.categoryId,
      placeLatitude: place.latitude,
      placeLongitude: place.longitude,
    });

    const result = await this.commit(trail, params.expectedRevision, proposed, {
      apply: TrailRepository.appendStop({
        trailId: params.trailId,
        placeId: params.placeId,
        source: params.source,
      }),
      event: 'trail.stop.added',
    });

    return result;
  }

  async removeStop(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
    stopId: string;
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);

    if (!trail.stops.some((stop) => stop.id === params.stopId)) {
      throw new InvalidStopOrderError('That stop is not on this trail.');
    }

    return this.commit(trail, params.expectedRevision, withStopRemoved(trail, params.stopId), {
      apply: TrailRepository.removeStop({ trailId: params.trailId, stopId: params.stopId }),
      event: 'trail.stop.removed',
    });
  }

  /**
   * Reorders every stop at once (§31).
   *
   * The request must name the *whole* set: a partial list would leave the unnamed
   * stops in an order nobody decided, and there is no sensible default for where they
   * go. Validating the set exactly makes the operation total.
   */
  async reorderStops(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
    orderedStopIds: readonly string[];
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);
    assertValidOrder(trail.stops, params.orderedStopIds);

    return this.commit(
      trail,
      params.expectedRevision,
      withStopsReordered(trail, params.orderedStopIds),
      {
        apply: TrailRepository.reorderStops({
          trailId: params.trailId,
          orderedStopIds: params.orderedStopIds,
        }),
        event: 'trail.reordered',
      },
    );
  }

  /** Replaces one or both endpoints, which also invalidates the base route (§39). */
  async updateEndpoints(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
    origin?: TrailEndpointInput | undefined;
    destination?: TrailEndpointInput | undefined;
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);

    const proposed = withEndpoints(trail, {
      origin: params.origin === undefined ? undefined : toEndpoint(params.origin),
      destination: params.destination === undefined ? undefined : toEndpoint(params.destination),
    });

    return this.commit(trail, params.expectedRevision, proposed, {
      apply: TrailRepository.noComposedChange(),
      endpoints: {
        origin: fromEndpoint(proposed.origin),
        destination: fromEndpoint(proposed.destination),
      },
      event: 'trail.endpoints.updated',
    });
  }

  /** Re-asks the provider for the same composition (§70). */
  async recalculate(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);

    return this.commit(trail, params.expectedRevision, currentComposition(trail), {
      apply: TrailRepository.noComposedChange(),
      /* An explicit refresh recomputes the baseline too, so the "+X min" it produces
         is measured against the same road network as the route itself (§40). */
      forceBaseRecalculation: true,
      event: 'trail.routing.recalculated',
    });
  }

  /* ---- Lifecycle ----------------------------------------------------------- */

  /**
   * Marks a Trail finished (§45).
   *
   * A Trail with no stops is perfectly valid — A → B is a journey someone may want to
   * keep. What is not valid is finalizing one whose route does not describe its
   * current composition (§22).
   */
  async finalize(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);
    if (!isRouteCurrent(trail)) throw new TrailRouteStaleError();

    const finalized = await this.trails.finalize(params);
    if (!finalized) throw new TrailRevisionConflictError(trail.revision, params.expectedRevision);

    this.logger.info({ event: 'trail.finalized' }, 'Trail finalized');
    return this.getForOwner(params.trailId, params.ownerUserId);
  }

  async archive(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
  }): Promise<Trail> {
    const trail = await this.readForMutation(params);

    const archived = await this.trails.archive(params);
    if (!archived) throw new TrailRevisionConflictError(trail.revision, params.expectedRevision);

    this.logger.info({ event: 'trail.archived' }, 'Trail archived');
    return this.getForOwner(params.trailId, params.ownerUserId);
  }

  /**
   * Deletes a Trail outright (§44).
   *
   * Hard delete is acceptable here precisely because nothing else references a Trail:
   * there are no saves, no comments and no shares in the product, so there is nothing
   * a tombstone would protect. When publication lands, this becomes a soft delete.
   */
  async delete(params: { trailId: string; ownerUserId: string }): Promise<void> {
    const deleted = await this.trails.delete(params);
    if (!deleted) throw new TrailNotFoundError();

    this.logger.info({ event: 'trail.deleted' }, 'Trail deleted');
  }

  /* ---- Internals ----------------------------------------------------------- */

  private async readForMutation(params: {
    trailId: string;
    ownerUserId: string;
    expectedRevision: number;
  }): Promise<Trail> {
    const trail = await this.getForOwner(params.trailId, params.ownerUserId);

    /* An early check, so an obviously stale client is refused before a provider call
       is spent on it. It is *not* the guarantee — that is the compare-and-set in
       `applyMutation`, which runs after the provider has replied. */
    if (trail.revision !== params.expectedRevision) {
      this.logger.info(
        { event: 'trail.revision.conflict', stage: 'precheck' },
        'Trail mutation rejected: stale revision',
      );
      throw new TrailRevisionConflictError(trail.revision, params.expectedRevision);
    }

    return trail;
  }

  /**
   * Routes a proposed composition, then commits it — or commits nothing (§83, §92).
   */
  private async commit(
    trail: Trail,
    expectedRevision: number,
    proposed: ProposedComposition,
    options: {
      apply: (tx: TransactionLike) => Promise<void>;
      endpoints?: { origin: TrailEndpointInput; destination: TrailEndpointInput } | undefined;
      forceBaseRecalculation?: boolean | undefined;
      event: string;
    },
  ): Promise<Trail> {
    /* No transaction is open here. If this throws, nothing has been written and the
       previous composition stands, untouched (§83). */
    const route = await this.route(proposed);
    const baseRoute = await this.baseRouteFor(trail, proposed, options.forceBaseRecalculation);

    const updated = await this.trails.applyMutation({
      trailId: trail.id,
      ownerUserId: trail.ownerUserId,
      expectedRevision,
      apply: options.apply,
      route,
      baseRoute,
      endpoints: options.endpoints,
    });

    if (updated === undefined) {
      /* Someone committed while the provider was answering. Re-read to report the
         revision the client should reload to. */
      const current = await this.trails.findByIdForOwner(trail.id, trail.ownerUserId);
      this.logger.info(
        { event: 'trail.revision.conflict', stage: 'commit' },
        'Trail mutation rejected: revision moved during routing',
      );
      throw new TrailRevisionConflictError(current?.revision ?? trail.revision, expectedRevision);
    }

    /* Counts only. A Trail's geometry and its stops are the user's own travel plans
       and never appear in a log line or a metric label (§76, §77). */
    this.logger.info(
      { event: options.event, stopCount: updated.stops.length, revision: updated.revision },
      'Trail mutated',
    );

    return updated;
  }

  private async route(composition: ProposedComposition): Promise<RouteSnapshotRecord> {
    const result = await this.calculateRoute.execute({
      origin: endpointToPoint(composition.origin),
      destination: endpointToPoint(composition.destination),
      waypoints: waypointsOf(composition),
      includeCorridor: false,
    });

    return {
      geometry: result.geometry,
      distanceMeters: result.metrics.distanceMeters,
      durationSeconds: result.metrics.durationSeconds,
      provider: result.provider,
    };
  }

  /**
   * The A → B baseline, recomputed only when it can have changed (§39, §40).
   *
   * The base route is a function of the endpoints alone, so a stop edit cannot
   * invalidate it and recomputing it there would be a billed call that changes
   * nothing. It *is* recomputed when the endpoints move, and when the user explicitly
   * asks for a refresh — the two cases where comparing it against a new composed route
   * would otherwise mix measurements.
   */
  private async baseRouteFor(
    trail: Trail,
    proposed: ProposedComposition,
    force: boolean | undefined,
  ): Promise<BaseRouteRecord | undefined> {
    const moved =
      endpointsChanged(trail.origin, proposed.origin) ||
      endpointsChanged(trail.destination, proposed.destination);

    if (force !== true && !moved && trail.baseRoute !== null) return undefined;

    /* A composition with no stops is its own baseline; asking twice would bill twice
       for the same answer. */
    if (proposed.stops.length === 0) return undefined;

    const base = await this.route({
      origin: proposed.origin,
      destination: proposed.destination,
      stops: [],
    });

    return { distanceMeters: base.distanceMeters, durationSeconds: base.durationSeconds };
  }
}

/**
 * A reorder must name exactly the stops the Trail has (§31).
 *
 * Each failure mode is reported separately because they mean different things: a
 * missing id is a client that dropped a row, a foreign id is a client editing the
 * wrong Trail, and a duplicate is a drag handler that fired twice.
 */
function assertValidOrder(stops: readonly TrailStop[], orderedIds: readonly string[]): void {
  const existing = new Set(stops.map((stop) => stop.id));
  const seen = new Set<string>();

  for (const id of orderedIds) {
    if (!existing.has(id)) throw new InvalidStopOrderError('That stop is not on this trail.');
    if (seen.has(id))
      throw new InvalidStopOrderError('A stop appears more than once in the order.');
    seen.add(id);
  }

  if (seen.size !== existing.size) {
    throw new InvalidStopOrderError('The order must list every stop on the trail.');
  }
}

function toEndpoint(input: TrailEndpointInput): TrailEndpoint {
  return {
    latitude: input.latitude,
    longitude: input.longitude,
    placeId: input.placeId ?? null,
    label: input.label ?? null,
  };
}

function fromEndpoint(endpoint: TrailEndpoint): TrailEndpointInput {
  return {
    latitude: endpoint.latitude,
    longitude: endpoint.longitude,
    ...(endpoint.placeId === null ? {} : { placeId: endpoint.placeId }),
    ...(endpoint.label === null ? {} : { label: endpoint.label }),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'UnknownError';
}
