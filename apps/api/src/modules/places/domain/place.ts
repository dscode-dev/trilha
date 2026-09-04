/**
 * Place domain types.
 *
 * Plain data — no Nest, no Drizzle, no HTTP.
 *
 * A Place is a location Trilha knows about, and nothing more. It carries no rating,
 * no safety score, no trail count and no popularity: those belong to domains that do
 * not exist yet, and a nullable column waiting for them is an invitation to fill it
 * with something fabricated (constitution §Domain).
 */

export const PlaceProvenance = {
  /** Submitted by an authenticated person. */
  COMMUNITY: 'COMMUNITY',
  /** Created by the platform itself. */
  SYSTEM: 'SYSTEM',
} as const;

export type PlaceProvenance = (typeof PlaceProvenance)[keyof typeof PlaceProvenance];

export const PlaceStatus = {
  ACTIVE: 'ACTIVE',
  PENDING_REVIEW: 'PENDING_REVIEW',
  ARCHIVED: 'ARCHIVED',
} as const;

export type PlaceStatus = (typeof PlaceStatus)[keyof typeof PlaceStatus];

/** Only ACTIVE places are visible to readers in V1. */
export function isPubliclyVisible(status: PlaceStatus): boolean {
  return status === PlaceStatus.ACTIVE;
}

export const PLACE_NAME_MAX_LENGTH = 120;
export const PLACE_DESCRIPTION_MAX_LENGTH = 1_000;

/**
 * Collapses runs of whitespace and trims (§14).
 *
 * Stored content is plain text, never HTML: escaping happens at render time in the
 * client, so there is no markup to sanitise and no chance of a half-sanitised string
 * being treated as safe later.
 */
export function normaliseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The shape returned for a marker. Deliberately minimal — see §18 and §27. */
export interface PlaceMapItem {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** A row in a search or nearby result. */
export interface PlaceListItem extends PlaceMapItem {
  readonly description: string | null;
  /** Present only for proximity queries, where a reference point exists. */
  readonly distanceMetres: number | null;
}

/** The full record behind a detail screen. */
export interface PlaceDetail extends PlaceMapItem {
  readonly description: string | null;
  readonly provenance: PlaceProvenance;
  readonly status: PlaceStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Public attribution only: a username, never an email or an account id. */
  readonly contributor: { readonly username: string; readonly displayName: string } | null;
}
