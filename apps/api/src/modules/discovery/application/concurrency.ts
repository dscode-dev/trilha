/**
 * Runs tasks with a bounded number in flight (§49).
 *
 * `Promise.all` over a batch list would fire every provider call at once. With a
 * generous ceiling that is a burst against a per-minute quota, and a burst is how a
 * shared quota gets exhausted by one request. A small worker pool keeps upstream
 * pressure flat and predictable, at a wall-clock cost that only appears when there is
 * more than one batch — which, at the configured ceilings, there is not.
 *
 * Results stay index-aligned with the input, so a caller can zip them back together.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Splits a list into chunks of at most [size]. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
