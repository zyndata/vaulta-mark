/**
 * Service-worker entry point.
 *
 * MV3 terminates this worker after roughly 30 seconds of inactivity and restarts it on the next
 * event, so top-level code stays cheap and holds no state worth losing. Phase 4 adds the session
 * and lock lifecycle; for now the worker exists to prove the plumbing works end to end.
 */

import { parseRequest, type Response } from '../shared/messages';

/**
 * Handle one validated message. Returns `null` for anything that is not ours, so unrelated
 * senders get no response rather than a misleading one.
 */
export function handleMessage(raw: unknown): Response | null {
  const request = parseRequest(raw);
  if (request === null) return null;

  // `PING` is the only request that exists today, so there is nothing to dispatch on yet.
  // Phase 4 turns this into a real router over the full message union.
  request satisfies { type: 'PING' };
  return { type: 'PONG', version: chrome.runtime.getManifest().version };
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const response = handleMessage(raw);
  if (response === null) return false;
  sendResponse(response);
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // Deliberately contentless: no URL, title, tag or note may ever reach a log, at any level.
  console.info('VaultaMark installed');
});
