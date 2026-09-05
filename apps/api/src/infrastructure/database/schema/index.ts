/**
 * Drizzle table definitions.
 *
 * Tables are added as their bounded contexts land, each with a migration under
 * `../migrations`. PR-01 introduces the identity domain; no other domain exists yet.
 */
export * from './identity.js';
export * from './places.js';
export * from './trails.js';
