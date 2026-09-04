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

  it('exposes no product-domain endpoints yet', () => {
    /* PR-00 is forbidden from shipping domain surface (§38). */
    const domainish = /(user|place|trail|review|rating|safety|event|suggestion)/i;
    expect(Object.keys(document.paths).filter((p) => domainish.test(p))).toEqual([]);
  });

  it('does not expose the wildcard not-found route as documentation', () => {
    expect(Object.keys(document.paths).some((p) => p.includes('*'))).toBe(false);
  });
});
