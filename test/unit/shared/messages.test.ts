import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  broadcast,
  onBroadcast,
  onRequest,
  parseBroadcast,
  parseRequest,
  parseResponse,
  parseSettingsPatch,
  send,
  type Request,
  type Response,
} from '../../../src/shared/messages.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
});

describe('parseRequest', () => {
  it('accepts every payload-free request', () => {
    for (const type of [
      'PING',
      'GET_STATE',
      'TOUCH',
      'GET_SETTINGS',
      'ADD_ACTIVE_TAB',
      'INCOGNITO_ACCESS',
      'LIST_ITEMS',
    ] as const) {
      expect(parseRequest({ type })).toEqual({ type });
    }
  });

  it('drops fields it does not know, so a caller cannot smuggle one past the router', () => {
    expect(parseRequest({ type: 'PING', password: 'hunter2' })).toEqual({ type: 'PING' });
  });

  it('requires a string password', () => {
    expect(parseRequest({ type: 'UNLOCK', password: 'correct horse' })).toEqual({
      type: 'UNLOCK',
      password: 'correct horse',
    });
    for (const password of [undefined, null, 42, {}, ['a']]) {
      expect(parseRequest({ type: 'UNLOCK', password })).toBeNull();
      expect(parseRequest({ type: 'CREATE_VAULT', password })).toBeNull();
    }
  });

  it('treats LOCK.panic as optional but typed', () => {
    expect(parseRequest({ type: 'LOCK' })).toEqual({ type: 'LOCK' });
    expect(parseRequest({ type: 'LOCK', panic: true })).toEqual({ type: 'LOCK', panic: true });
    expect(parseRequest({ type: 'LOCK', panic: 'yes' })).toBeNull();
  });

  it('requires a non-empty string URL on ADD_URL, with an optional string title', () => {
    expect(parseRequest({ type: 'ADD_URL', url: 'https://example.com/' })).toEqual({
      type: 'ADD_URL',
      url: 'https://example.com/',
    });
    expect(parseRequest({ type: 'ADD_URL', url: 'https://example.com/', title: 'X' })).toEqual({
      type: 'ADD_URL',
      url: 'https://example.com/',
      title: 'X',
    });
    for (const url of [undefined, null, '', 42, {}]) {
      expect(parseRequest({ type: 'ADD_URL', url })).toBeNull();
    }
    expect(parseRequest({ type: 'ADD_URL', url: 'https://example.com/', title: 7 })).toBeNull();
  });

  it('takes an optional query and a positive integer limit on LIST_ITEMS', () => {
    expect(parseRequest({ type: 'LIST_ITEMS', query: 'git', limit: 5 })).toEqual({
      type: 'LIST_ITEMS',
      query: 'git',
      limit: 5,
    });
    expect(parseRequest({ type: 'LIST_ITEMS', query: '' })).toEqual({
      type: 'LIST_ITEMS',
      query: '',
    });
    for (const limit of [0, -1, 1.5, '20', Number.NaN, Number.MAX_VALUE]) {
      expect(parseRequest({ type: 'LIST_ITEMS', limit })).toBeNull();
    }
    expect(parseRequest({ type: 'LIST_ITEMS', query: 7 })).toBeNull();
  });

  it('requires an id on OPEN_ITEM, DELETE_ITEM and RESTORE_ITEM', () => {
    for (const type of ['OPEN_ITEM', 'DELETE_ITEM', 'RESTORE_ITEM'] as const) {
      expect(parseRequest({ type, id: 'abc' })).toMatchObject({ type, id: 'abc' });
      for (const id of [undefined, null, '', 42]) {
        expect(parseRequest({ type, id })).toBeNull();
      }
    }
  });

  it('treats the OPEN_ITEM escape hatches as optional but typed', () => {
    expect(parseRequest({ type: 'OPEN_ITEM', id: 'a', force: true })).toEqual({
      type: 'OPEN_ITEM',
      id: 'a',
      force: true,
    });
    expect(parseRequest({ type: 'OPEN_ITEM', id: 'a', clearHistoryAfter: false })).toEqual({
      type: 'OPEN_ITEM',
      id: 'a',
      clearHistoryAfter: false,
    });
    // `force` is what turns "open in incognito" into "open in a normal window". A non-boolean must
    // never coerce its way through.
    expect(parseRequest({ type: 'OPEN_ITEM', id: 'a', force: 'yes' })).toBeNull();
    expect(parseRequest({ type: 'OPEN_ITEM', id: 'a', clearHistoryAfter: 1 })).toBeNull();
  });

  it('treats INCOGNITO_ACCESS.recheck as optional but typed', () => {
    expect(parseRequest({ type: 'INCOGNITO_ACCESS', recheck: true })).toEqual({
      type: 'INCOGNITO_ACCESS',
      recheck: true,
    });
    expect(parseRequest({ type: 'INCOGNITO_ACCESS', recheck: 'yes' })).toBeNull();
  });

  it('rejects anything that is not one of ours', () => {
    for (const raw of [null, undefined, 'PING', 42, [], {}, { type: 'NOT_OURS' }, { type: 7 }]) {
      expect(parseRequest(raw)).toBeNull();
    }
  });
});

describe('parseSettingsPatch', () => {
  it('accepts an empty patch and each field on its own', () => {
    expect(parseSettingsPatch({})).toEqual({});
    expect(parseSettingsPatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(parseSettingsPatch({ idleTimeoutMinutes: 30 })).toEqual({ idleTimeoutMinutes: 30 });
    expect(parseSettingsPatch({ providerId: 'drive' })).toEqual({ providerId: 'drive' });
    expect(parseSettingsPatch({ lockOnBrowserBlur: true })).toEqual({ lockOnBrowserBlur: true });
    expect(parseSettingsPatch({ stripTrackingParams: true })).toEqual({
      stripTrackingParams: true,
    });
    expect(parseSettingsPatch({ reuseIncognitoWindow: false })).toEqual({
      reuseIncognitoWindow: false,
    });
  });

  it('accepts 0 minutes, which is how "never auto-lock" is spelled', () => {
    expect(parseSettingsPatch({ idleTimeoutMinutes: 0 })).toEqual({ idleTimeoutMinutes: 0 });
  });

  it('rejects the whole patch on any bad field rather than half-applying it', () => {
    expect(parseSettingsPatch({ theme: 'chartreuse' })).toBeNull();
    expect(parseSettingsPatch({ theme: 'dark', idleTimeoutMinutes: -1 })).toBeNull();
    expect(parseSettingsPatch({ idleTimeoutMinutes: Number.NaN })).toBeNull();
    expect(parseSettingsPatch({ idleTimeoutMinutes: '10' })).toBeNull();
    expect(parseSettingsPatch({ providerId: 'dropbox' })).toBeNull();
    expect(parseSettingsPatch({ lockOnBrowserBlur: 'yes' })).toBeNull();
    expect(parseSettingsPatch({ stripTrackingParams: 1 })).toBeNull();
    expect(parseSettingsPatch({ reuseIncognitoWindow: 'on' })).toBeNull();
    expect(parseSettingsPatch('nope')).toBeNull();
    expect(parseSettingsPatch(null)).toBeNull();
  });

  it('rides along on SET_SETTINGS', () => {
    expect(parseRequest({ type: 'SET_SETTINGS', settings: { theme: 'light' } })).toEqual({
      type: 'SET_SETTINGS',
      settings: { theme: 'light' },
    });
    expect(parseRequest({ type: 'SET_SETTINGS', settings: { theme: 'nope' } })).toBeNull();
    expect(parseRequest({ type: 'SET_SETTINGS' })).toBeNull();
  });
});

describe('parseResponse / parseBroadcast', () => {
  it('recognises every response type', () => {
    for (const type of [
      'PONG',
      'STATE',
      'OK',
      'SETTINGS',
      'TOUCHED',
      'ADDED',
      'ITEMS',
      'OPENED',
      'INCOGNITO_ACCESS_STATE',
      'ERROR',
    ]) {
      expect(parseResponse({ type })).toEqual({ type });
    }
    expect(parseResponse({ type: 'SESSION_LOCKED' })).toBeNull();
    expect(parseResponse(undefined)).toBeNull();
  });

  it('recognises every broadcast type and nothing else', () => {
    for (const type of [
      'SESSION_LOCKED',
      'SESSION_UNLOCKED',
      'SETTINGS_CHANGED',
      'VAULT_CHANGED',
    ]) {
      expect(parseBroadcast({ type })).toEqual({ type });
    }
    expect(parseBroadcast({ type: 'PONG' })).toBeNull();
    expect(parseBroadcast(42)).toBeNull();
  });
});

describe('send', () => {
  it('returns the response the router produced', async () => {
    onRequest((request: Request): Promise<Response> => {
      expect(request.type).toBe('PING');
      return Promise.resolve({ type: 'PONG', version: '9.9.9' });
    });
    await expect(send({ type: 'PING' })).resolves.toEqual({ type: 'PONG', version: '9.9.9' });
  });

  it('reports an unreachable worker instead of rejecting', async () => {
    vi.spyOn(mock.chrome.runtime, 'sendMessage').mockRejectedValue(
      new Error('Could not establish connection.'),
    );
    await expect(send({ type: 'PING' })).resolves.toEqual({
      type: 'ERROR',
      code: 'UNREACHABLE',
    });
  });

  it('reports an unparseable answer as UNKNOWN', async () => {
    mock.chrome.runtime.onMessage.addListener((_message, _sender, sendResponse) => {
      sendResponse({ type: 'WAT' });
      return false;
    });
    await expect(send({ type: 'PING' })).resolves.toEqual({ type: 'ERROR', code: 'UNKNOWN' });
  });
});

describe('onRequest', () => {
  it('stays silent for messages that are not ours, so other senders get no answer', async () => {
    onRequest(() => Promise.resolve({ type: 'OK' }));
    await expect(mock.sendMessage({ type: 'NOT_OURS' })).resolves.toBeUndefined();
  });

  it('turns a thrown handler into an ERROR rather than a hung channel', async () => {
    onRequest(() => Promise.reject(new Error('boom')));
    await expect(mock.sendMessage({ type: 'PING' })).resolves.toEqual({
      type: 'ERROR',
      code: 'UNKNOWN',
    });
  });
});

describe('broadcast / onBroadcast', () => {
  it('delivers broadcasts and ignores everything else', async () => {
    const seen: string[] = [];
    onBroadcast((message) => seen.push(message.type));

    await broadcast({ type: 'SESSION_LOCKED', reason: 'manual' });
    await broadcast({ type: 'SESSION_UNLOCKED', unlockedUntil: 1 });
    await mock.sendMessage({ type: 'PING' });

    expect(seen).toEqual(['SESSION_LOCKED', 'SESSION_UNLOCKED']);
  });

  it('unsubscribes', async () => {
    const seen: string[] = [];
    const off = onBroadcast((message) => seen.push(message.type));
    off();
    await broadcast({ type: 'SESSION_LOCKED', reason: 'manual' });
    expect(seen).toEqual([]);
  });

  it('swallows "nobody is listening", which is the normal case for an idle lock', async () => {
    vi.spyOn(mock.chrome.runtime, 'sendMessage').mockRejectedValue(
      new Error('Receiving end does not exist.'),
    );
    await expect(broadcast({ type: 'SESSION_LOCKED', reason: 'expired' })).resolves.toBeUndefined();
  });
});
