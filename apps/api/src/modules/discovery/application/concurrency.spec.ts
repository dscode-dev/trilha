import { describe, expect, it } from 'vitest';
import { chunk, mapWithConcurrency } from './concurrency.js';

/** Batching and the provider-call ceiling (§49, §21). */
describe('chunk', () => {
  it('splits a list into batches of at most the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one batch when everything fits', () => {
    expect(chunk([1, 2, 3], 23)).toEqual([[1, 2, 3]]);
  });

  it('returns nothing for an empty list, so no call is made', () => {
    expect(chunk([], 23)).toEqual([]);
  });
});

describe('mapWithConcurrency', () => {
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps results index-aligned with the input', async () => {
    const results = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
      await settle(value * 5);
      return value * 10;
    });

    expect(results).toEqual([30, 10, 20]);
  });

  it('never exceeds the configured width', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await settle(5);
        inFlight -= 1;
        return null;
      },
    );

    /* A burst against a per-minute provider quota is how a shared quota gets
       exhausted by a single request (§49). */
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('actually runs work in parallel up to the width', async () => {
    let peak = 0;
    let inFlight = 0;

    await mapWithConcurrency([1, 2, 3, 4], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await settle(10);
      inFlight -= 1;
      return null;
    });

    expect(peak).toBeGreaterThan(1);
  });

  it('does nothing for an empty list', async () => {
    let calls = 0;

    const results = await mapWithConcurrency([], 4, async () => {
      calls += 1;
      await settle(1);
      return null;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('propagates a failure rather than returning a partial array', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (value) => {
        await settle(1);
        if (value === 2) throw new Error('upstream is down');
        return value;
      }),
    ).rejects.toThrow('upstream is down');
  });

  it('treats a width larger than the input as the input size', async () => {
    const results = await mapWithConcurrency([1, 2], 99, (value) => Promise.resolve(value));

    expect(results).toEqual([1, 2]);
  });
});
