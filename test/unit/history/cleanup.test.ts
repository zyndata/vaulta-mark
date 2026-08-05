/**
 * The `chrome.history` half of the cleanup (ARCHITECTURE §12.2), against the mocked API.
 *
 * The assertion that matters in this file is the **exact `deleteUrl` call list**. `history.search`
 * is a substring match and hands back other people's sites; every test here seeds history with the
 * over-matches Chrome would really return and then asserts that none of them was deleted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HistoryPermissionError,
  deleteHistory,
  domainsOf,
  dropHistoryPermission,
  hasHistoryPermission,
  requestHistoryPermission,
  scanHistory,
} from '../../../src/history/cleanup.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from '../../mocks/chrome.js';

let mock: ChromeMock;

beforeEach(() => {
  mock = installChromeMock({ grantedPermissions: ['history'] });
});

afterEach(() => {
  uninstallChromeMock();
});

function seed(...urls: readonly (string | { url: string; title: string })[]): void {
  for (const entry of urls) {
    mock.historyEntries.push(typeof entry === 'string' ? { url: entry } : entry);
  }
}

describe('the permission', () => {
  it('reports, requests and gives back', async () => {
    uninstallChromeMock();
    mock = installChromeMock();

    expect(await hasHistoryPermission()).toBe(false);
    expect(await requestHistoryPermission()).toBe(true);
    expect(await hasHistoryPermission()).toBe(true);
    expect(await dropHistoryPermission()).toBe(true);
    expect(await hasHistoryPermission()).toBe(false);
  });

  it('is an error class with a name, not a bare Error', () => {
    const error = new HistoryPermissionError('clearing history');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HistoryPermissionError');
  });
});

describe('scanHistory', () => {
  it('counts only the entries that really belong to the domain', async () => {
    seed(
      'https://example.com/one',
      'https://www.example.com/two',
      // Everything below is a substring hit that `search('example.com')` returns and that must not
      // be counted or deleted.
      'https://notexample.community/three',
      'https://example.com.evil.test/four',
      'https://elsewhere.test/?ref=example.com',
      { url: 'https://unrelated.test/five', title: 'A post about example.com' },
    );

    const scan = await scanHistory(['example.com']);

    expect(scan.domains).toEqual([{ domain: 'example.com', entries: 2 }]);
    expect(scan.urls).toEqual(['https://example.com/one', 'https://www.example.com/two']);
  });

  it('asks Chrome for exactly the domains it was given, and no others', async () => {
    seed('https://example.com/one', 'https://other.test/two');
    await scanHistory(['example.com', 'bbc.co.uk']);
    expect(mock.historySearches).toEqual(['example.com', 'bbc.co.uk']);
  });

  it('omits domains with nothing in history from the breakdown, but still searched them', async () => {
    seed('https://example.com/one');
    const scan = await scanHistory(['example.com', 'never-visited.test']);

    expect(scan.domains).toEqual([{ domain: 'example.com', entries: 1 }]);
    expect(mock.historySearches).toEqual(['example.com', 'never-visited.test']);
  });

  it('deduplicates a URL two searches both matched', async () => {
    // `search('bbc.co.uk')` and `search('co.uk')` would both return this, and counting it twice
    // would overstate the dry run and delete it twice on the way out.
    seed('https://bbc.co.uk/news');
    const scan = await scanHistory(['bbc.co.uk', 'bbc.co.uk']);
    expect(scan.urls).toEqual(['https://bbc.co.uk/news']);
  });

  it('asks for the whole history rather than Chrome default page of results', async () => {
    // `maxResults: 0` is Chrome's "no limit". The mock reproduces the capping behaviour, so a
    // regression to `maxResults: 100` would lose entries here.
    for (let at = 0; at < 150; at++) seed(`https://example.com/page-${String(at)}`);
    const scan = await scanHistory(['example.com']);
    expect(scan.urls).toHaveLength(150);
  });

  it('answers with nothing for a domain that matches nothing', async () => {
    const scan = await scanHistory(['example.com']);
    expect(scan.domains).toEqual([]);
    expect(scan.urls).toEqual([]);
  });
});

describe('deleteHistory', () => {
  it('deletes exactly the URLs it was handed, in order', async () => {
    seed('https://example.com/one', 'https://example.com/two', 'https://other.test/three');
    const scan = await scanHistory(['example.com']);

    expect(await deleteHistory(scan.urls)).toBe(2);
    expect(mock.deletedHistory).toEqual(['https://example.com/one', 'https://example.com/two']);
    // The unrelated site is untouched, both in the call list and in the profile.
    expect(mock.historyEntries.map((entry) => entry.url)).toEqual(['https://other.test/three']);
  });

  it('carries on past a URL Chrome refuses, and counts only what really went', async () => {
    seed('https://a.test/', 'https://b.test/');
    mock.undeletableHistory.add('https://a.test/');

    expect(await deleteHistory(['https://a.test/', 'https://b.test/'])).toBe(1);
    expect(mock.deletedHistory).toEqual(['https://b.test/']);
  });
});

describe('domainsOf', () => {
  it('reduces URLs to distinct registrable domains, in first-seen order', () => {
    expect(
      domainsOf([
        'https://news.bbc.co.uk/a',
        'https://www.bbc.co.uk/b',
        'https://example.com/c',
        'https://sub.example.com/d',
      ]),
    ).toEqual(['bbc.co.uk', 'example.com']);
  });

  it('drops anything with no host to reason about', () => {
    expect(domainsOf(['not a url', 'about:blank', 'https://example.com/ok'])).toEqual([
      'example.com',
    ]);
  });
});
