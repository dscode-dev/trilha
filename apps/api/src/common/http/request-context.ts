import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request ambient context (§12).
 *
 * Backed by `AsyncLocalStorage` so any layer — including code with no access to
 * the HTTP request object — can attach the correlation id to logs and errors
 * without threading a parameter through every signature.
 */
export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const REQUEST_ID_HEADER = 'x-request-id';

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Returns the active context, or `undefined` outside of a request (jobs, boot). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
