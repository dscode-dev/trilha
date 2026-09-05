import type { RouteMetrics, RoutePoint } from '../../routing/domain/route.js';

/**
 * The port for measuring what a detour costs (§20).
 *
 * Separate from `RoutingProvider` rather than bolted onto it, because the two answer
 * different questions. `RoutingProvider` produces *a route* — a drawable geometry a
 * user will follow. This produces *a number* — how much longer a journey becomes if
 * it passes through a point. Discovery needs the second and never the first, and a
 * provider might well serve them from different APIs with different limits, which is
 * exactly what happens with the concrete adapter here.
 *
 * Nothing in this file names a vendor. Discovery depends on this interface, so no part
 * of the discovery pipeline knows a Mapbox exists (§20).
 */
export interface RouteCostProvider {
  /**
   * How many via-points one call can evaluate.
   *
   * Exposed because batching is the caller's decision and the ceiling is the
   * provider's fact. Hiding it inside the adapter would mean the application layer
   * could not state its own worst-case call count (§98).
   */
  readonly maxViaPointsPerCall: number;

  /**
   * Cost of `origin → via[i] → destination` for each via-point.
   *
   * Results are index-aligned with `request.via`. A `null` entry means the provider
   * could not connect that point by road — a real answer about that place, not a
   * failure of the request (§50).
   */
  viaCosts(request: ViaCostRequest): Promise<ViaCostResult>;
}

export interface ViaCostRequest {
  readonly origin: RoutePoint;
  readonly destination: RoutePoint;
  readonly via: readonly RoutePoint[];
}

export interface ViaCostResult {
  /**
   * The provider's own `origin → destination` cost.
   *
   * The baseline is taken from the same call as the via costs on purpose. Subtracting
   * a Directions route's duration from a matrix duration would mix two engines'
   * answers, and the difference between them would show up as phantom detour minutes
   * on every candidate (§17).
   */
  readonly baseline: RouteMetrics;
  readonly via: readonly (RouteMetrics | null)[];
  readonly provider: { readonly name: string; readonly latencyMs: number };
}

/** Injection token — the port is an interface and has no runtime identity. */
export const ROUTE_COST_PROVIDER = Symbol('RouteCostProvider');
