import type { RouteGeometry, RouteLeg, RouteMetrics, RoutePoint } from './route.js';

/**
 * The port through which routes are calculated (§9).
 *
 * Application code depends on this interface and never on a vendor. That is what lets
 * a test substitute a deterministic provider without touching a line of domain code,
 * and what would let Trilha change supplier without the change reaching past
 * `infrastructure/` (§64, §65).
 *
 * Note what the port does *not* expose: no provider name in the types, no raw
 * response, no vendor-shaped options. A `RoutingResult` is Trilha's own vocabulary.
 */
export interface RoutingProvider {
  /**
   * Computes a driving route between two points.
   *
   * Throws one of the normalised routing errors — never a provider-shaped exception.
   */
  calculateRoute(request: RoutingRequest): Promise<RoutingResult>;
}

export interface RoutingRequest {
  readonly origin: RoutePoint;
  readonly destination: RoutePoint;
  /**
   * Intermediate points, visited in the order given (PR-05, §15, §16).
   *
   * The provider is told *where* to go and in *what order*; it never chooses. Trilha
   * has no optimiser and does not want one here — the sequence is the user's
   * composition, and reordering it to save four minutes would silently discard the
   * decision they made.
   *
   * Routing still knows nothing about Trails. It receives ordered points; that they
   * came from a `TrailStop` is not a fact this layer needs (§16).
   */
  readonly waypoints?: readonly RoutePoint[] | undefined;
  /**
   * Only driving exists in V1 (§29). Modelled because providers require it on the
   * wire, and because a second mode is a value here rather than a new code path.
   */
  readonly profile: RoutingProfile;
}

export const RoutingProfile = { DRIVING: 'DRIVING' } as const;
export type RoutingProfile = (typeof RoutingProfile)[keyof typeof RoutingProfile];

/**
 * What a provider returns, in Trilha's terms.
 *
 * Deliberately not `Route`: the use case adds bounds and the corridor, both of which
 * Trilha computes rather than receives. Keeping them apart makes it obvious which
 * parts of a result are the provider's word and which are ours.
 */
export interface RoutingResult {
  readonly geometry: RouteGeometry;
  readonly metrics: RouteMetrics;
  readonly legs: readonly RouteLeg[];
  /** Non-sensitive attribution, for logs and support. Never credentials or a URL. */
  readonly provider: ProviderAttribution;
}

export interface ProviderAttribution {
  readonly name: string;
  /** Milliseconds spent upstream, so provider latency is separable from ours (§60). */
  readonly latencyMs: number;
}

/** Injection token — the port is an interface and has no runtime identity. */
export const ROUTING_PROVIDER = Symbol('RoutingProvider');
