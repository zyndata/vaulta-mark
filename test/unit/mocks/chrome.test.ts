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

  it('records tab creation', async () => {
    const mock = createChromeMock();
    await mock.chrome.tabs.create({ url: 'chrome-extension://x/manager.html' });
    expect(mock.createdTabs).toEqual([{ url: 'chrome-extension://x/manager.html' }]);
  });

  it('fires keyboard commands and focus changes', () => {
    const mock = createChromeMock();
    const commands: string[] = [];
    const focus: number[] = [];
    mock.chrome.commands.onCommand.addListener((name) => commands.push(name));
    mock.chrome.windows.onFocusChanged.addListener((id) => focus.push(id));
    mock.triggerCommand('panic-lock');
    mock.triggerFocusChanged(mock.chrome.windows.WINDOW_ID_NONE);
    expect(commands).toEqual(['panic-lock']);
    expect(focus).toEqual([-1]);
  });

  it('reports focus the way Chrome does: a last-focused window that need not be focused', async () => {
    const mock = createChromeMock();
    const window_ = await mock.chrome.windows.create({ url: 'https://example.com/' });

    expect(await mock.chrome.windows.getLastFocused()).toMatchObject({
      id: window_?.id,
      focused: true,
    });

    // `WINDOW_ID_NONE` does not close or forget the window — it says none is in front.
    mock.triggerFocusChanged(mock.chrome.windows.WINDOW_ID_NONE);
    expect(await mock.chrome.windows.getLastFocused()).toMatchObject({
      id: window_?.id,
      focused: false,
    });
  });

  it('rejects getLastFocused when no window is open, rather than answering undefined', async () => {
    const mock = createChromeMock();
    await expect(mock.chrome.windows.getLastFocused()).rejects.toThrow(/No window/);
  });

  it('says which window holds the focus, not merely that one exists', async () => {
    const mock = createChromeMock();
    const first = await mock.chrome.windows.create({ url: 'https://example.com/' });
    const second = await mock.chrome.windows.create({ url: 'https://example.org/' });

    // `getAll` is what the blur policy asks, because "a window is in front" and "this window is in
    // front" are different questions and only this one answers the second.
    expect(await mock.chrome.windows.getAll()).toEqual([
      expect.objectContaining({ id: first?.id, focused: false }),
      expect.objectContaining({ id: second?.id, focused: true }),
    ]);

    mock.triggerFocusChanged(mock.chrome.windows.WINDOW_ID_NONE);
    expect((await mock.chrome.windows.getAll()).some((window_) => window_.focused)).toBe(false);
  });

  it('carries a port between a page and the worker, and closes it at both ends', () => {
    const mock = createChromeMock();
    const received: unknown[] = [];
    let disconnected = false;
    mock.chrome.runtime.onConnect.addListener((port) => {
      expect(port.name).toBe('vm.focus');
      port.onMessage.addListener((message) => received.push(message));
      port.onDisconnect.addListener(() => {
        disconnected = true;
      });
    });

    const port = mock.chrome.runtime.connect({ name: 'vm.focus' });
    port.postMessage({ focused: true });
    expect(received).toEqual([{ focused: true }]);

    port.disconnect();
    expect(disconnected).toBe(true);
    // Chrome throws on a port that has been disconnected; the beacon catches exactly this.
    expect(() => {
      port.postMessage({ focused: false });
    }).toThrow(/disconnected/);
  });

  it('takes every port down with the worker, and tells the page', () => {
    const mock = createChromeMock();
    let disconnected = false;
    mock.chrome.runtime.onConnect.addListener(() => undefined);
    const port = mock.chrome.runtime.connect({ name: 'vm.focus' });
    port.onDisconnect.addListener(() => {
      disconnected = true;
    });

    mock.terminateWorker();

    expect(disconnected).toBe(true);
  });

  it('drops a connect nobody listens for, with lastError, as Chrome does', async () => {
    vi.useFakeTimers();
    const mock = createChromeMock();
    // No `onConnect` listener: the worker has not registered one yet, which is the state an
    // extension page is reloaded into when an unpacked build is reloaded under it.
    const port = mock.chrome.runtime.connect({ name: 'vm.focus' });
    let seen: string | undefined;
    port.onDisconnect.addListener(() => {
      seen = mock.chrome.runtime.lastError?.message;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toMatch(/Receiving end does not exist/);
    // Chrome clears it once the listener has had its chance; an error left standing would be read
    // by whatever asked next.
    expect(mock.chrome.runtime.lastError).toBeUndefined();
    vi.useRealTimers();
  });

  it('omits chrome.idle until the optional permission is granted, as Chrome does', () => {
    const withoutIdle = createChromeMock();
    // The namespace is genuinely absent, which is what src/background/autolock.ts checks for.
    expect((withoutIdle.chrome as { idle?: unknown }).idle).toBeUndefined();
    expect(() => {
      withoutIdle.triggerIdleState('idle');
    }).toThrow(/optional "idle" permission/);

    const withIdle = createChromeMock({ grantedPermissions: ['idle'] });
    const states: string[] = [];
    withIdle.chrome.idle.onStateChanged.addListener((state) => states.push(state));
    withIdle.chrome.idle.setDetectionInterval(600);
    withIdle.triggerIdleState('locked');
    expect(states).toEqual(['locked']);
    expect(withIdle.idleDetectionInterval()).toBe(600);
  });

  it('lets a test observe what the worker broadcast', async () => {
    const mock = createChromeMock();
    const seen = mock.observeMessages();
    await mock.chrome.runtime.sendMessage({ type: 'SESSION_LOCKED', reason: 'panic' });
    expect(seen).toEqual([{ type: 'SESSION_LOCKED', reason: 'panic' }]);
  });

  it('records the session area access level', async () => {
    const mock = createChromeMock();
    expect(mock.storage.session.accessLevel).toBeUndefined();
    await mock.chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(mock.storage.session.accessLevel).toBe('TRUSTED_CONTEXTS');
  });
});
