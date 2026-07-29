import { createChromeMock, createClock, itemBytes, SYNC_LIMITS } from '../../mocks/chrome';

describe('chrome.storage mock', () => {
  it('round-trips values through local storage', async () => {
    const { chrome } = createChromeMock();
    await chrome.storage.local.set({ 'vm.meta': { vaultRev: 1 } });
    expect(await chrome.storage.local.get('vm.meta')).toEqual({ 'vm.meta': { vaultRev: 1 } });
    await chrome.storage.local.remove('vm.meta');
    expect(await chrome.storage.local.get(null)).toEqual({});
  });

  it('reports defaults for missing keys, as Chrome does', async () => {
    const { chrome } = createChromeMock();
    expect(await chrome.storage.local.get({ 'vm.settings': { theme: 'system' } })).toEqual({
      'vm.settings': { theme: 'system' },
    });
  });

  it('notifies storage.onChanged listeners with the area name', async () => {
    const mock = createChromeMock();
    const seen: { area: string; keys: string[] }[] = [];
    mock.chrome.storage.onChanged.addListener((changes, area) => {
      seen.push({ area, keys: Object.keys(changes) });
    });
    await mock.chrome.storage.sync.set({ 'vm.s.meta': { vaultRev: 2 } });
    expect(seen).toEqual([{ area: 'sync', keys: ['vm.s.meta'] }]);
  });

  describe('sync quotas', () => {
    it('enforces QUOTA_BYTES_PER_ITEM', async () => {
      const { chrome } = createChromeMock();
      const oversized = 'x'.repeat(SYNC_LIMITS.QUOTA_BYTES_PER_ITEM);
      await expect(chrome.storage.sync.set({ 'vm.s.b0.0': oversized })).rejects.toThrow(
        'QUOTA_BYTES_PER_ITEM quota exceeded',
      );

      // One byte under the cap, counting the key and the JSON quoting, is accepted.
      const key = 'vm.s.b0.0';
      let value = 'x'.repeat(SYNC_LIMITS.QUOTA_BYTES_PER_ITEM - key.length - 2);
      expect(itemBytes(key, value)).toBe(SYNC_LIMITS.QUOTA_BYTES_PER_ITEM);
      value = value.slice(1);
      await expect(chrome.storage.sync.set({ [key]: value })).resolves.toBeUndefined();
    });

    it('enforces the total byte quota', async () => {
      const { chrome } = createChromeMock();
      const part = 'x'.repeat(7_600);
      for (let i = 0; i < 13; i += 1) {
        await chrome.storage.sync.set({ [`vm.s.b${String(i)}.0`]: part });
      }
      expect(await chrome.storage.sync.getBytesInUse(null)).toBeLessThan(SYNC_LIMITS.QUOTA_BYTES);
      await expect(chrome.storage.sync.set({ 'vm.s.b13.0': part })).rejects.toThrow(
        'QUOTA_BYTES quota exceeded',
      );
    });

    it('enforces MAX_ITEMS', async () => {
      const clock = createClock();
      const { chrome } = createChromeMock({ clock });
      const items: Record<string, string> = {};
      for (let i = 0; i < SYNC_LIMITS.MAX_ITEMS + 1; i += 1) items[`k${String(i)}`] = 'v';
      await expect(chrome.storage.sync.set(items)).rejects.toThrow('MAX_ITEMS quota exceeded');
    });

    it('leaves the stored data untouched when a write is rejected', async () => {
      const { chrome, storage } = createChromeMock();
      await chrome.storage.sync.set({ good: 'value' });
      await expect(
        chrome.storage.sync.set({ bad: 'x'.repeat(SYNC_LIMITS.QUOTA_BYTES_PER_ITEM) }),
      ).rejects.toThrow();
      expect(storage.sync.snapshot()).toEqual({ good: 'value' });
    });
  });

  describe('sync write rate', () => {
    it('enforces MAX_WRITE_OPERATIONS_PER_MINUTE and recovers as the window slides', async () => {
      const clock = createClock();
      const { chrome, storage } = createChromeMock({ clock });

      for (let i = 0; i < SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_MINUTE; i += 1) {
        await chrome.storage.sync.set({ k: i });
      }
      expect(storage.sync.writesInLastMinute()).toBe(SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_MINUTE);

      await expect(chrome.storage.sync.set({ k: 'one too many' })).rejects.toThrow(
        'MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded',
      );

      clock.advance(61_000);
      await expect(chrome.storage.sync.set({ k: 'later' })).resolves.toBeUndefined();
    });

    it('enforces MAX_WRITE_OPERATIONS_PER_HOUR across sliding minutes', async () => {
      const clock = createClock();
      const { chrome } = createChromeMock({ clock });

      for (let minute = 0; minute < 15; minute += 1) {
        for (let i = 0; i < SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_MINUTE; i += 1) {
          await chrome.storage.sync.set({ k: i });
        }
        clock.advance(61_000);
      }

      await expect(chrome.storage.sync.set({ k: 'over the hourly budget' })).rejects.toThrow(
        'MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded',
      );
    });

    it('does not rate-limit local or session storage', async () => {
      const { chrome } = createChromeMock();
      for (let i = 0; i < 500; i += 1) {
        await chrome.storage.local.set({ k: i });
        await chrome.storage.session.set({ k: i });
      }
      expect(await chrome.storage.local.get('k')).toEqual({ k: 499 });
    });
  });
});

describe('chrome runtime, alarms and windows mocks', () => {
  it('routes a message to the listener and resolves with its response', async () => {
    const mock = createChromeMock();
    mock.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type: string }).type === 'PING') sendResponse({ type: 'PONG' });
      return false;
    });
    await expect(mock.sendMessage({ type: 'PING' })).resolves.toEqual({ type: 'PONG' });
  });

  it('resolves with undefined when nothing answers', async () => {
    const mock = createChromeMock();
    await expect(mock.sendMessage({ type: 'PING' })).resolves.toBeUndefined();
  });

  it('arms and fires alarms against the mock clock', () => {
    const mock = createChromeMock();
    const fired: string[] = [];
    mock.chrome.alarms.onAlarm.addListener((alarm) => fired.push(alarm.name));
    void mock.chrome.alarms.create('vm.autolock', { delayInMinutes: 10 });
    expect(mock.alarms.get('vm.autolock')?.scheduledTime).toBe(mock.clock.now() + 600_000);
    mock.triggerAlarm('vm.autolock');
    expect(fired).toEqual(['vm.autolock']);
    expect(() => {
      mock.triggerAlarm('vm.nope');
    }).toThrow();
  });

  it('records incognito window creation', async () => {
    const mock = createChromeMock();
    await mock.chrome.windows.create({ url: 'https://example.com/', incognito: true });
    expect(mock.createdWindows).toEqual([{ url: 'https://example.com/', incognito: true }]);
  });

  it('starts with optional permissions ungranted, as a fresh install does', async () => {
    const mock = createChromeMock();
    await expect(mock.chrome.permissions.contains({ permissions: ['history'] })).resolves.toBe(
      false,
    );
    await mock.chrome.permissions.request({ permissions: ['history'] });
    await expect(mock.chrome.permissions.contains({ permissions: ['history'] })).resolves.toBe(
      true,
    );
  });
});
