/**
 * The message contract between the extension's contexts.
 *
 * Every request and response type is declared here as part of a discriminated union — there are
 * no ad-hoc string message types anywhere else in the codebase. Phase 4 grows this into the full
 * session/lock/vault protocol; Phase 1 only needs a heartbeat that proves the service worker is
 * alive and reachable.
 *
 * Anything arriving over `chrome.runtime.onMessage` is untrusted input, hence `parseRequest`.
 */

export interface PingRequest {
  readonly type: 'PING';
}

export type Request = PingRequest;

export interface PongResponse {
  readonly type: 'PONG';
  /** The running extension version, as Chrome sees it. */
  readonly version: string;
}

export type Response = PongResponse;

const REQUEST_TYPES: ReadonlySet<Request['type']> = new Set<Request['type']>(['PING']);

/** Narrow an unvalidated message to a known request, or `null` if it is not one of ours. */
export function parseRequest(raw: unknown): Request | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type } = raw as { type?: unknown };
  if (typeof type !== 'string' || !REQUEST_TYPES.has(type as Request['type'])) return null;
  return { type } as Request;
}
