import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildOpenApiDocument, createApp } from '../../src/bootstrap.js';

/**
 * Guards the published API contract (§31, §32).
 *
 * The document is built from live Nest metadata, so these assertions fail the moment
 * a route or the error envelope changes without the contract being regenerated.
 */
describe('OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    /* No init(): building the document needs route metadata, not live dependencies. */
    app = await createApp();
    document = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('describes both platform endpoints', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/api/v1/health', '/api/v1/ready']),
    );
  });

  it('documents readiness as able to fail', () => {
    const responses = document.paths['/api/v1/ready']?.get?.responses ?? {};
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '503']));
  });

  it('publishes the shared error envelope', () => {
    const schemas = document.components?.schemas ?? {};

    expect(schemas['ErrorResponse']).toBeDefined();
    expect(schemas['ErrorBody']).toBeDefined();
    expect(Object.keys((schemas['ErrorBody'] as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['code', 'message', 'requestId']),
    );
  });

  /**
   * Scope freeze.
   *
   * Each PR removes its own domain from this list as it ships it — identity in PR-01,
   * places in PR-02, routing in PR-03, trails in PR-05 — and everything still frozen
   * stays. The guard is what makes an accidentally-shipped route fail a build rather
   * than pass review.
   *
   * `trail` leaves the list here, but publication does not follow it: `publish`,
   * `share` and `comment` are added, because a Trail Builder is the exact place
   * someone would be tempted to ship the social layer early (§72, §108).
   */
  it('exposes no endpoints for domains that are still frozen', () => {
    const frozen =
      /(review|rating|safety|event|suggestion|feed|badge|follower|recommendation|publish|share|comment)/i;
    expect(Object.keys(document.paths).filter((path) => frozen.test(path))).toEqual([]);
  });

  it('documents the places domain introduced by PR-02', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/places',
        '/api/v1/places/map',
        '/api/v1/places/nearby',
        '/api/v1/places/search',
        '/api/v1/places/categories',
        '/api/v1/places/{id}',
      ]),
    );
  });

  it('documents the routing domain introduced by PR-03', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/api/v1/routes/calculate']),
    );
  });

  it('documents routing as authenticated and able to fail upstream', () => {
    const calculate = document.paths['/api/v1/routes/calculate']?.post;

    expect(JSON.stringify(calculate?.security ?? [])).toMatch(/bearer/i);
    /* Upstream failures are part of the contract, not surprises. */
    expect(Object.keys(calculate?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '422', '429', '502', '504']),
    );
  });

  it('keeps the routing contract free of provider vocabulary (§64)', () => {
    const serialised = JSON.stringify(document);

    /* A change of routing supplier must not be a change to the published contract. */
    expect(serialised.toLowerCase()).not.toContain('mapbox');
    expect(serialised).not.toContain('access_token');
  });

  it('documents the map query as able to reject a bad viewport', () => {
    const responses = document.paths['/api/v1/places/map']?.get?.responses ?? {};
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400']));
  });

  it('marks place creation as requiring a bearer token', () => {
    const security = document.paths['/api/v1/places']?.post?.security ?? [];
    expect(JSON.stringify(security)).toMatch(/bearer/i);
  });

  it('documents the discovery domain introduced by PR-04', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/api/v1/discovery/routes']),
    );
  });

  it('documents discovery as authenticated and able to fail upstream', () => {
    const discover = document.paths['/api/v1/discovery/routes']?.post;

    /* Discovery spends a route calculation *and* a matrix call per request, so an
       anonymous version would be a free proxy to two metered APIs (§41). */
    expect(JSON.stringify(discover?.security ?? [])).toMatch(/bearer/i);
    expect(Object.keys(discover?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '422', '429', '502', '504']),
    );
  });

  it('publishes the relevance reason codes clients must map (§35)', () => {
    const serialised = JSON.stringify(document);

    /* The client owns the wording; the contract owns the vocabulary. */
    expect(serialised).toContain('LOW_DETOUR');
    expect(serialised).toContain('ON_ROUTE');
    expect(serialised).toContain('GOOD_ROUTE_POSITION');
  });

  it('exposes no rating, safety or popularity field on a candidate (§58, §87)', () => {
    const schema = document.components?.schemas?.RouteCandidateDto as
      { properties?: Record<string, unknown> } | undefined;
    const fields = Object.keys(schema?.properties ?? {});

    /* Field *names*, not descriptions: none of these signals exist in the product
       yet, and a documented field is an invitation to fill it with something
       fabricated. The descriptions may well mention a rating in order to say the
       score is not one. */
    for (const forbidden of [/rating/i, /safety/i, /popular/i, /review/i, /vote/i]) {
      expect(fields.filter((field) => forbidden.test(field))).toEqual([]);
    }
  });

  it('documents the trails domain introduced by PR-05', () => {
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/trails',
        '/api/v1/trails/{id}',
        '/api/v1/trails/{id}/stops',
        '/api/v1/trails/{id}/stops/{stopId}',
        '/api/v1/trails/{id}/stops/order',
        '/api/v1/trails/{id}/recalculate',
        '/api/v1/trails/{id}/finalize',
      ]),
    );
  });

  it('requires a bearer token on every trail route (§53)', () => {
    const trailPaths = Object.entries(document.paths).filter(([path]) =>
      path.startsWith('/api/v1/trails'),
    );

    expect(trailPaths.length).toBeGreaterThan(0);
    for (const [path, operations] of trailPaths) {
      for (const [method, operation] of Object.entries(operations)) {
        const security = (operation as { security?: unknown }).security ?? [];
        expect(JSON.stringify(security), `${method} ${path}`).toMatch(/bearer/i);
      }
    }
  });

  it('documents the revision conflict every mutation can return (§25, §78)', () => {
    const addStop = document.paths['/api/v1/trails/{id}/stops']?.post;

    /* A client that cannot tell a conflict from a validation error will either
       overwrite or give up; both are worse than reloading. */
    expect(Object.keys(addStop?.responses ?? {})).toEqual(expect.arrayContaining(['409']));
  });

  it('never asks a client for a user id (§53)', () => {
    const trailDocument = JSON.stringify(
      Object.fromEntries(
        Object.entries(document.paths).filter(([path]) => path.startsWith('/api/v1/trails')),
      ),
    );

    /* Ownership comes from the session. A userId in a request body would be an
       invitation to edit someone else's trail. */
    expect(trailDocument).not.toMatch(/"(ownerUserId|userId)"/);
  });

  it('exposes no publication, rating or safety field on a trail (§72, §108)', () => {
    for (const schemaName of ['TrailDetailDto', 'TrailSummaryDto', 'TrailStopDto']) {
      const schema = document.components?.schemas?.[schemaName] as
        { properties?: Record<string, unknown> } | undefined;
      const fields = Object.keys(schema?.properties ?? {});

      for (const forbidden of [/public/i, /slug/i, /share/i, /comment/i, /rating/i, /safety/i]) {
        expect(
          fields.filter((field) => forbidden.test(field)),
          schemaName,
        ).toEqual([]);
      }
    }
  });

  it('does not expose the wildcard not-found route as documentation', () => {
    expect(Object.keys(document.paths).some((p) => p.includes('*'))).toBe(false);
  });
});
