import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  broadcast,
  onBroadcast,
  onRequest,
  parseBroadcast,
  parseItemEdit,
  parseRequest,
  parseResponse,
  parseSettingsPatch,
  send,
  type Request,
  type Response,
} from '../../../src/shared/messages.js';
import { DETAIL_WIDTH, SIDEBAR_WIDTH, TOOLBAR_TITLE_MAX } from '../../../src/vault/types.js';
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

  it('requires both a password and a named backend to adopt a synced vault', () => {
    expect(parseRequest({ type: 'ADOPT_REMOTE_VAULT', password: 'theirs', from: 'drive' })).toEqual({
      type: 'ADOPT_REMOTE_VAULT',
      password: 'theirs',
      from: 'drive',
    });
    // The backend is not defaulted. This request erases the vault on this profile and replaces it
    // with whatever is in the named one; guessing which one that is is not a thing to do quietly.
    for (const from of [undefined, null, '', 'sync', 42]) {
      expect(parseRequest({ type: 'ADOPT_REMOTE_VAULT', password: 'theirs', from })).toBeNull();
    }
    expect(parseRequest({ type: 'ADOPT_REMOTE_VAULT', from: 'chrome' })).toBeNull();
  });

  it('treats CONNECT_DRIVE.replaceExisting as optional but typed', () => {
    expect(parseRequest({ type: 'CONNECT_DRIVE' })).toEqual({ type: 'CONNECT_DRIVE' });
    expect(parseRequest({ type: 'CONNECT_DRIVE', replaceExisting: true })).toEqual({
      type: 'CONNECT_DRIVE',
      replaceExisting: true,
    });
    expect(parseRequest({ type: 'CONNECT_DRIVE', replaceExisting: 'yes' })).toBeNull();
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

  it('requires an id on OPEN_ITEM and GET_ITEM', () => {
    for (const type of ['OPEN_ITEM', 'GET_ITEM'] as const) {
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

  /* --- the manager (Phase 6) --- */

  it('takes the payload-free manager requests bare', () => {
    for (const type of ['GET_TREE', 'COUNT_TRACKING_PARAMS', 'STRIP_TRACKING_PARAMS'] as const) {
      expect(parseRequest({ type })).toEqual({ type });
      // Extra fields are dropped rather than rejected: the parser's output is what the router sees.
      expect(parseRequest({ type, extra: 'ignored' })).toEqual({ type });
    }
  });

  it('takes DESTROY_VAULT bare, and its deleteRemote flag only as a boolean', () => {
    // Bare stays bare rather than defaulting here: the router is the one place that decides what an
    // absent flag means, and a parser that filled it in would put that decision in two files.
    expect(parseRequest({ type: 'DESTROY_VAULT' })).toEqual({ type: 'DESTROY_VAULT' });
    expect(parseRequest({ type: 'DESTROY_VAULT', deleteRemote: false })).toEqual({
      type: 'DESTROY_VAULT',
      deleteRemote: false,
    });
    expect(parseRequest({ type: 'DESTROY_VAULT', deleteRemote: 'no' })).toBeNull();
  });

  it('takes every LIST_VIEW field as optional, and each of them typed', () => {
    expect(parseRequest({ type: 'LIST_VIEW' })).toEqual({ type: 'LIST_VIEW' });
    expect(
      parseRequest({ type: 'LIST_VIEW', folderId: 'f', query: 'x', sort: 'title', untagged: true }),
    ).toEqual({ type: 'LIST_VIEW', folderId: 'f', query: 'x', sort: 'title', untagged: true });
    // An empty query is meaningful — "the user cleared the box" — and an empty folder id is not.
    expect(parseRequest({ type: 'LIST_VIEW', query: '' })).toEqual({ type: 'LIST_VIEW', query: '' });
    for (const bad of [
      { folderId: '' },
      { folderId: 7 },
      { query: 7 },
      { sort: 'sideways' },
      { sort: 4 },
      { untagged: 'yes' },
    ]) {
      expect(parseRequest({ type: 'LIST_VIEW', ...bad }), JSON.stringify(bad)).toBeNull();
    }
  });

  it('requires a non-empty id list on every bulk request', () => {
    for (const type of ['DELETE_ITEMS', 'RESTORE_ITEMS', 'TAG_ITEMS', 'MOVE_ITEMS'] as const) {
      const extra = type === 'MOVE_ITEMS' ? { parentId: 'root' } : {};
      expect(parseRequest({ type, ids: ['a', 'b'], ...extra })).toMatchObject({
        type,
        ids: ['a', 'b'],
      });
      // An empty selection is a bug in the caller, and answering OK to it is how that bug reaches
      // a user as "the button does nothing sometimes".
      for (const ids of [undefined, [], ['a', ''], ['a', 7], 'a', {}]) {
        expect(parseRequest({ type, ids, ...extra }), JSON.stringify(ids)).toBeNull();
      }
    }
  });

  it('types the tag lists on TAG_ITEMS, and leaves both optional', () => {
    expect(parseRequest({ type: 'TAG_ITEMS', ids: ['a'] })).toEqual({
      type: 'TAG_ITEMS',
      ids: ['a'],
    });
    expect(parseRequest({ type: 'TAG_ITEMS', ids: ['a'], add: ['x'], remove: ['y'] })).toEqual({
      type: 'TAG_ITEMS',
      ids: ['a'],
      add: ['x'],
      remove: ['y'],
    });
    expect(parseRequest({ type: 'TAG_ITEMS', ids: ['a'], add: 'x' })).toBeNull();
    expect(parseRequest({ type: 'TAG_ITEMS', ids: ['a'], remove: [7] })).toBeNull();
  });

  it('requires a parent on MOVE_ITEMS and a mode on DELETE_FOLDER', () => {
    expect(parseRequest({ type: 'MOVE_ITEMS', ids: ['a'], parentId: '' })).toBeNull();
    for (const mode of ['recursive', 'reparent'] as const) {
      expect(parseRequest({ type: 'DELETE_FOLDER', id: 'f', mode })).toEqual({
        type: 'DELETE_FOLDER',
        id: 'f',
        mode,
      });
    }
    for (const mode of [undefined, '', 'purge', 7]) {
      expect(parseRequest({ type: 'DELETE_FOLDER', id: 'f', mode })).toBeNull();
    }
  });

  it('requires a title on CREATE_FOLDER and leaves the parent optional', () => {
    expect(parseRequest({ type: 'CREATE_FOLDER', title: 'Work' })).toEqual({
      type: 'CREATE_FOLDER',
      title: 'Work',
    });
    expect(parseRequest({ type: 'CREATE_FOLDER', title: 'Work', parentId: 'p' })).toEqual({
      type: 'CREATE_FOLDER',
      title: 'Work',
      parentId: 'p',
    });
    expect(parseRequest({ type: 'CREATE_FOLDER', title: '' })).toBeNull();
    expect(parseRequest({ type: 'CREATE_FOLDER', title: 'Work', parentId: '' })).toBeNull();
  });

  it('requires both names on RENAME_TAG and both passwords on CHANGE_PASSWORD', () => {
    expect(parseRequest({ type: 'RENAME_TAG', from: 'a', to: 'b' })).toEqual({
      type: 'RENAME_TAG',
      from: 'a',
      to: 'b',
    });
    expect(parseRequest({ type: 'RENAME_TAG', from: 'a', to: '' })).toBeNull();

    // DELETE_TAG names one tag, and an empty one would be a request to walk the vault removing
    // nothing — refused here rather than treated as a no-op three layers down.
    expect(parseRequest({ type: 'DELETE_TAG', tag: 'reading' })).toEqual({
      type: 'DELETE_TAG',
      tag: 'reading',
    });
    expect(parseRequest({ type: 'DELETE_TAG', tag: '' })).toBeNull();
    expect(parseRequest({ type: 'DELETE_TAG' })).toBeNull();

    expect(
      parseRequest({ type: 'CHANGE_PASSWORD', currentPassword: 'a', newPassword: 'b' }),
    ).toEqual({ type: 'CHANGE_PASSWORD', currentPassword: 'a', newPassword: 'b' });
    // Length is the repository's rule, not the parser's — but the type is the parser's.
    expect(parseRequest({ type: 'CHANGE_PASSWORD', currentPassword: 'a', newPassword: 7 })).toBeNull();
  });

  /* --- import and export (Phase 8) --- */

  it('requires a password and a known mode on EXPORT_VAULT', () => {
    expect(parseRequest({ type: 'EXPORT_VAULT', password: 'p', mode: 'vault' })).toEqual({
      type: 'EXPORT_VAULT',
      password: 'p',
      mode: 'vault',
    });
    // An empty password is a legal string and refused by the vault, not by the parser.
    expect(parseRequest({ type: 'EXPORT_VAULT', password: '', mode: 'custom' })).toEqual({
      type: 'EXPORT_VAULT',
      password: '',
      mode: 'custom',
    });
    expect(parseRequest({ type: 'EXPORT_VAULT', password: 'p' })).toBeNull();
    expect(parseRequest({ type: 'EXPORT_VAULT', password: 'p', mode: 'both' })).toBeNull();
    expect(parseRequest({ type: 'EXPORT_VAULT', password: 7, mode: 'vault' })).toBeNull();
  });

  it('requires a non-empty file and a string password on the import messages', () => {
    expect(parseRequest({ type: 'PREVIEW_IMPORT', file: '{}', password: '' })).toEqual({
      type: 'PREVIEW_IMPORT',
      file: '{}',
      password: '',
    });
    expect(parseRequest({ type: 'PREVIEW_IMPORT', file: '', password: 'p' })).toBeNull();
    expect(parseRequest({ type: 'PREVIEW_IMPORT', file: '{}' })).toBeNull();

    expect(parseRequest({ type: 'IMPORT_VAULT', file: '{}', password: 'p', mode: 'merge' })).toEqual(
      { type: 'IMPORT_VAULT', file: '{}', password: 'p', mode: 'merge' },
    );
    expect(parseRequest({ type: 'IMPORT_VAULT', file: '{}', password: 'p' })).toBeNull();
    expect(
      parseRequest({ type: 'IMPORT_VAULT', file: '{}', password: 'p', mode: 'overwrite' }),
    ).toBeNull();
  });

  it('takes the payload-free import messages', () => {
    for (const type of ['GET_ROLLBACK', 'ROLLBACK_IMPORT', 'NATIVE_TREE'] as const) {
      expect(parseRequest({ type })).toEqual({ type });
    }
  });

  it('requires a non-empty id list on the native messages', () => {
    expect(parseRequest({ type: 'IMPORT_NATIVE', ids: ['1'] })).toEqual({
      type: 'IMPORT_NATIVE',
      ids: ['1'],
    });
    expect(parseRequest({ type: 'IMPORT_NATIVE', ids: ['1'], parentId: 'f1' })).toEqual({
      type: 'IMPORT_NATIVE',
      ids: ['1'],
      parentId: 'f1',
    });
    expect(parseRequest({ type: 'IMPORT_NATIVE', ids: [] })).toBeNull();
    expect(parseRequest({ type: 'IMPORT_NATIVE', ids: ['1'], parentId: '' })).toBeNull();

    expect(parseRequest({ type: 'DELETE_NATIVE', ids: ['10'] })).toEqual({
      type: 'DELETE_NATIVE',
      ids: ['10'],
    });
    // "Delete nothing" answering OK is how a bug in a caller reaches a user as "sometimes it does
    // nothing" — and this is the one message where the alternative is deleting the wrong thing.
    expect(parseRequest({ type: 'DELETE_NATIVE', ids: [] })).toBeNull();
    expect(parseRequest({ type: 'DELETE_NATIVE', ids: [7] })).toBeNull();
  });
});

describe('parseItemEdit', () => {
  it('accepts an empty patch and each field on its own', () => {
    expect(parseItemEdit({})).toEqual({});
    expect(parseItemEdit({ title: 'A' })).toEqual({ title: 'A' });
    // An empty title is legal — a bookmark may have none — but an empty URL is not a URL.
    expect(parseItemEdit({ title: '' })).toEqual({ title: '' });
    expect(parseItemEdit({ url: 'https://example.com/' })).toEqual({ url: 'https://example.com/' });
    expect(parseItemEdit({ note: 'hello' })).toEqual({ note: 'hello' });
    expect(parseItemEdit({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
  });

  it('carries null through, because it is the only way to clear a field', () => {
    expect(parseItemEdit({ note: null })).toEqual({ note: null });
    expect(parseItemEdit({ tags: null })).toEqual({ tags: null });
  });

  it('rejects the whole patch on any bad field rather than dropping it', () => {
    for (const bad of [
      { title: 7 },
      { url: '' },
      { url: 7 },
      { note: 7 },
      { tags: 'a' },
      { tags: [7] },
      { tags: ['a', null] },
    ]) {
      expect(parseItemEdit(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const raw of [null, undefined, 'patch', 42]) {
      expect(parseItemEdit(raw)).toBeNull();
    }
  });

  it('does not accept fields only the extension may write', () => {
    // `openedAt`, `openCount`, `og` and `thumb` are written in response to what happened, never by
    // someone typing. The cheapest way to keep a UI from writing them is for the wire not to carry
    // them — so they are dropped, and a request that is only those is an empty patch.
    expect(parseItemEdit({ openedAt: 1, openCount: 2, og: {}, thumb: {} })).toEqual({});
  });

  it('is what UPDATE_ITEM validates its patch with', () => {
    expect(parseRequest({ type: 'UPDATE_ITEM', id: 'a', patch: { title: 'x' } })).toEqual({
      type: 'UPDATE_ITEM',
      id: 'a',
      patch: { title: 'x' },
    });
    expect(parseRequest({ type: 'UPDATE_ITEM', id: 'a', patch: { url: '' } })).toBeNull();
    expect(parseRequest({ type: 'UPDATE_ITEM', id: '', patch: {} })).toBeNull();
    expect(parseRequest({ type: 'UPDATE_ITEM', id: 'a' })).toBeNull();
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

  it('clamps a pane width instead of refusing it', () => {
    // The sender is a mouse drag against the edge of the window, and "the widest allowed" is a
    // better answer to it than a refused write that leaves the column where it was.
    expect(parseSettingsPatch({ sidebarWidth: 300 })).toEqual({ sidebarWidth: 300 });
    expect(parseSettingsPatch({ sidebarWidth: 4_000 })).toEqual({
      sidebarWidth: SIDEBAR_WIDTH.max,
    });
    expect(parseSettingsPatch({ detailWidth: -20 })).toEqual({ detailWidth: DETAIL_WIDTH.min });
    // Non-numbers are still a bug in the caller, not a gesture, and are refused with the patch.
    expect(parseSettingsPatch({ detailWidth: '400' })).toBeNull();
    expect(parseSettingsPatch({ sidebarWidth: Number.NaN })).toBeNull();
  });

  it('takes a toolbar icon by name and nothing else', () => {
    expect(parseSettingsPatch({ toolbarIcon: 'folder' })).toEqual({ toolbarIcon: 'folder' });
    expect(parseSettingsPatch({ toolbarIcon: 'aubergine' })).toBeNull();
    expect(parseSettingsPatch({ toolbarIcon: 2 })).toBeNull();
  });

  it('normalises a toolbar tooltip instead of refusing it', () => {
    // The sender is a text field with a `maxlength`, so nothing typed can reach the cap — and a
    // refusal that answered "your tooltip had two spaces in it" would be a control that silently
    // does nothing.
    expect(parseSettingsPatch({ toolbarTitle: '  Reading   list \n' })).toEqual({
      toolbarTitle: 'Reading list',
    });
    // The empty string is a value, not an absent field: it is how "use the shipped tooltip" is said.
    expect(parseSettingsPatch({ toolbarTitle: '   ' })).toEqual({ toolbarTitle: '' });
    expect(parseSettingsPatch({ toolbarTitle: 'x'.repeat(200) })).toEqual({
      toolbarTitle: 'x'.repeat(TOOLBAR_TITLE_MAX),
    });
    expect(parseSettingsPatch({ toolbarTitle: 7 })).toBeNull();
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
      'DUPLICATES',
      'FILE',
      'IMPORT_PREVIEW',
      'IMPORT_RESULT',
      'ROLLBACK',
      'NATIVE_TREE_STATE',
      'NATIVE_IMPORT',
      'NATIVE_DELETE',
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
      'IO_PROGRESS',
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
