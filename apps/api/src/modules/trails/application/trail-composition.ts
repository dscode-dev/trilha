import type { RoutePoint } from '../../routing/domain/route.js';
import type { Trail, TrailEndpoint, TrailStop } from '../domain/trail.js';

/**
 * A proposed composition, before anything is written (§29).
 *
 * The pipeline every mutation follows is: read the current Trail, build the
 * composition it *would* have, ask routing what that costs, then write. This type is
 * the middle step — a plain value, computed in memory, with no database handle and no
 * side effects.
 *
 * It exists so that the provider call happens against a fully-decided composition and
 * outside any transaction. Without it, the natural shape is "write, then route, then
 * write again", which is exactly the shape that leaves a Trail with stops it has no
 * route for.
 */
export interface ProposedComposition {
  readonly origin: TrailEndpoint;
  readonly destination: TrailEndpoint;
  /** In visiting order. Routing receives exactly this sequence (§15). */
  readonly stops: readonly TrailStop[];
}

/** The points routing needs, in order: origin, each stop, destination. */
export function waypointsOf(composition: ProposedComposition): RoutePoint[] {
  return composition.stops.map((stop) => ({
    latitude: stop.placeLatitude,
    longitude: stop.placeLongitude,
    placeId: stop.placeId,
  }));
}

export function endpointToPoint(endpoint: TrailEndpoint): RoutePoint {
  return {
    latitude: endpoint.latitude,
    longitude: endpoint.longitude,
    ...(endpoint.placeId === null ? {} : { placeId: endpoint.placeId }),
  };
}

/** The composition as it currently stands. */
export function currentComposition(trail: Trail): ProposedComposition {
  return { origin: trail.origin, destination: trail.destination, stops: trail.stops };
}

/** The composition with one stop appended. */
export function withStopAppended(
  trail: Trail,
  stop: Omit<TrailStop, 'id' | 'position'>,
): ProposedComposition {
  return {
    origin: trail.origin,
    destination: trail.destination,
    stops: [...trail.stops, { ...stop, id: 'proposed', position: trail.stops.length + 1 }],
  };
}

/** The composition with one stop removed and positions closed up. */
export function withStopRemoved(trail: Trail, stopId: string): ProposedComposition {
  return {
    origin: trail.origin,
    destination: trail.destination,
    stops: trail.stops
      .filter((stop) => stop.id !== stopId)
      .map((stop, index) => ({ ...stop, position: index + 1 })),
  };
}

/** The composition with its stops in the given order. */
export function withStopsReordered(
  trail: Trail,
  orderedStopIds: readonly string[],
): ProposedComposition {
  const byId = new Map(trail.stops.map((stop) => [stop.id, stop]));

  return {
    origin: trail.origin,
    destination: trail.destination,
    stops: orderedStopIds.flatMap((id, index) => {
      const stop = byId.get(id);
      return stop === undefined ? [] : [{ ...stop, position: index + 1 }];
    }),
  };
}

/** The composition with different endpoints. */
export function withEndpoints(
  trail: Trail,
  endpoints: { origin?: TrailEndpoint | undefined; destination?: TrailEndpoint | undefined },
): ProposedComposition {
  return {
    origin: endpoints.origin ?? trail.origin,
    destination: endpoints.destination ?? trail.destination,
    stops: trail.stops,
  };
}

/** Whether the endpoints differ, which is what makes the base route stale (§39). */
export function endpointsChanged(a: TrailEndpoint, b: TrailEndpoint): boolean {
  return a.latitude !== b.latitude || a.longitude !== b.longitude;
}
