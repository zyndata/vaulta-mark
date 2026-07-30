/**
 * An in-memory `chrome.*` for unit and integration tests.
 *
 * The parts that matter are the storage areas: `chrome.storage.sync` is a hostile little API
 * with per-item byte caps, a total byte cap, an item-count cap and two write-rate ceilings, and
 * every one of those turns into a user-visible failure in the field if we only ever test against
 * an infinite in-memory map. So the mock enforces them, with an injectable clock so a test can
 * exhaust a rate budget without waiting a minute.
 *
 * Everything else (runtime, alarms, windows, permissions, identity, i18n) is a straightforward
 * fake with listener plumbing and a manual trigger, because MV3 gives us no way to provoke those
 * events from inside a test.
 *
 * Not a general-purpose `chrome` implementation: it models what VaultaMark actually calls, and
 * fails loudly on the rest.
 */

/** Chrome's documented `chrome.storage.sync` limits — docs/ARCHITECTURE.md §5.2. */
export const SYNC_LIMITS = {
  QUOTA_BYTES: 102_400,
  QUOTA_BYTES_PER_ITEM: 8_192,
  MAX_ITEMS: 512,
  MAX_WRITE_OPERATIONS_PER_HOUR: 1_800,
  MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
} as const;

/** `chrome.storage.local`'s cap. `storage.session` has its own, much smaller one. */
export const LOCAL_LIMITS = {
  QUOTA_BYTES: 10_485_760,
} as const;

export const SESSION_LIMITS = {
  QUOTA_BYTES: 10_485_760,
} as const;

/** A stand-in for the 32-character id Chrome assigns; only its shape matters to us. */
const EXTENSION_ID = 'vaultamarktestextensionidaaaaaaaa';

export type StoredValue = unknown;
export type StorageSnapshot = Record<string, StoredValue>;

export interface StorageChange {
  oldValue?: StoredValue;
  newValue?: StoredValue;
}

type ChangeListener = (changes: Record<string, StorageChange>, areaName: string) => void;

export interface Clock {
  now(): number;
  /** Move the mock clock forward. Rate budgets are recomputed against it, nothing else. */
  advance(ms: number): void;
}

export function createClock(start = 1_750_000_000_000): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

interface AreaLimits {
  quotaBytes: number;
  quotaBytesPerItem?: number;
  maxItems?: number;
  maxWritesPerMinute?: number;
  maxWritesPerHour?: number;
}

/** Chrome charges the key name plus the JSON encoding of the value against the quota. */
export function itemBytes(key: string, value: StoredValue): number {
  return key.length + JSON.stringify(value).length;
}

class StorageArea {
  readonly #data = new Map<string, StoredValue>();
  readonly #writes: number[] = [];

  constructor(
    private readonly name: string,
    private readonly limits: AreaLimits,
    private readonly clock: Clock,
    private readonly emit: (changes: Record<string, StorageChange>, area: string) => void,
  ) {}

  get QUOTA_BYTES(): number {
    return this.limits.quotaBytes;
  }

  get QUOTA_BYTES_PER_ITEM(): number | undefined {
    return this.limits.quotaBytesPerItem;
  }

  get MAX_ITEMS(): number | undefined {
    return this.limits.maxItems;
  }

  /** Test helper: the raw contents, without going through the quota machinery. */
  snapshot(): StorageSnapshot {
    return Object.fromEntries(this.#data);
  }

  /** Test helper: the number of write operations charged in the current minute. */
  writesInLastMinute(): number {
    return this.#writesSince(60_000);
  }

  get = (
    keys?: string | string[] | Record<string, StoredValue> | null,
  ): Promise<StorageSnapshot> => {
    if (keys === undefined || keys === null) return Promise.resolve(this.snapshot());

    const result: StorageSnapshot = {};
    if (typeof keys === 'string') {
      if (this.#data.has(keys)) result[keys] = this.#data.get(keys);
      return Promise.resolve(result);
    }
    if (Array.isArray(keys)) {
      for (const key of keys) if (this.#data.has(key)) result[key] = this.#data.get(key);
      return Promise.resolve(result);
    }
    for (const [key, fallback] of Object.entries(keys)) {
      result[key] = this.#data.has(key) ? this.#data.get(key) : fallback;
    }
    return Promise.resolve(result);
  };

  set = (items: Record<string, StoredValue>): Promise<void> => {
    const rateError = this.#chargeWrite();
    if (rateError) return Promise.reject(rateError);

    const { quotaBytesPerItem, maxItems, quotaBytes } = this.limits;

    for (const [key, value] of Object.entries(items)) {
      if (value === undefined) {
        return Promise.reject(
          new Error(`${this.name}: value for "${key}" is not JSON-serializable`),
        );
      }
      if (quotaBytesPerItem !== undefined && itemBytes(key, value) > quotaBytesPerItem) {
        return Promise.reject(new Error('QUOTA_BYTES_PER_ITEM quota exceeded'));
      }
    }

    const projected = new Map(this.#data);
    for (const [key, value] of Object.entries(items)) projected.set(key, value);

    if (maxItems !== undefined && projected.size > maxItems) {
      return Promise.reject(new Error('MAX_ITEMS quota exceeded'));
    }
    if (this.#bytesOf(projected) > quotaBytes) {
      return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
    }

    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      const oldValue = this.#data.get(key);
      if (this.#data.has(key)) changes[key] = { oldValue, newValue: value };
      else changes[key] = { newValue: value };
      this.#data.set(key, value);
    }
    this.emit(changes, this.name);
    return Promise.resolve();
  };

  remove = (keys: string | string[]): Promise<void> => {
    const rateError = this.#chargeWrite();
    if (rateError) return Promise.reject(rateError);

    const changes: Record<string, StorageChange> = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!this.#data.has(key)) continue;
      changes[key] = { oldValue: this.#data.get(key) };
      this.#data.delete(key);
    }
    if (Object.keys(changes).length > 0) this.emit(changes, this.name);
    return Promise.resolve();
  };

  clear = (): Promise<void> => {
    const rateError = this.#chargeWrite();
    if (rateError) return Promise.reject(rateError);

    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of this.#data) changes[key] = { oldValue: value };
    this.#data.clear();
    if (Object.keys(changes).length > 0) this.emit(changes, this.name);
    return Promise.resolve();
  };

  getBytesInUse = (keys?: string | string[] | null): Promise<number> => {
    if (keys === undefined || keys === null) return Promise.resolve(this.#bytesOf(this.#data));
    const list = typeof keys === 'string' ? [keys] : keys;
    let total = 0;
    for (const key of list) {
      if (this.#data.has(key)) total += itemBytes(key, this.#data.get(key));
    }
    return Promise.resolve(total);
  };

  /** `storage.session` only; recorded so a test can assert we set TRUSTED_CONTEXTS. */
  accessLevel: string | undefined = undefined;
  setAccessLevel = (options: { accessLevel: string }): Promise<void> => {
    this.accessLevel = options.accessLevel;
    return Promise.resolve();
  };

  #bytesOf(data: Map<string, StoredValue>): number {
    let total = 0;
    for (const [key, value] of data) total += itemBytes(key, value);
    return total;
  }

  #writesSince(windowMs: number): number {
    const cutoff = this.clock.now() - windowMs;
    return this.#writes.filter((at) => at > cutoff).length;
  }

  #chargeWrite(): Error | null {
    const { maxWritesPerMinute, maxWritesPerHour } = this.limits;
    if (maxWritesPerMinute === undefined && maxWritesPerHour === undefined) return null;

    if (maxWritesPerMinute !== undefined && this.#writesSince(60_000) >= maxWritesPerMinute) {
      return new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
    }
    if (maxWritesPerHour !== undefined && this.#writesSince(3_600_000) >= maxWritesPerHour) {
      return new Error('MAX_WRITE_OPERATIONS_PER_HOUR quota exceeded');
    }

    this.#writes.push(this.clock.now());
    return null;
  }
}

class Event<Listener extends (...args: never[]) => unknown> {
  readonly listeners = new Set<Listener>();
  addListener = (listener: Listener): void => void this.listeners.add(listener);
  removeListener = (listener: Listener): void => void this.listeners.delete(listener);
  hasListener = (listener: Listener): boolean => this.listeners.has(listener);
  hasListeners = (): boolean => this.listeners.size > 0;
}

export interface ChromeMock {
  /** The object to install as `globalThis.chrome`. */
  readonly chrome: typeof chrome;
  readonly clock: Clock;
  readonly storage: {
    readonly local: StorageArea;
    readonly sync: StorageArea;
    readonly session: StorageArea;
  };
  /** Permissions the profile has granted. Optional ones start ungranted, as in a fresh install. */
  readonly grantedPermissions: Set<string>;
  /** Windows created via `chrome.windows.create`, in order. */
  readonly createdWindows: { url?: string | string[]; incognito?: boolean }[];
  /** Alarms currently armed, by name. */
  readonly alarms: Map<string, { periodInMinutes?: number; scheduledTime: number }>;
  /**
   * Drop every registered listener, the way MV3 tearing the service worker down does.
   *
   * Call this before re-importing the worker in a test that simulates a restart. Without it the
   * old module registry keeps answering messages alongside the new one — two workers over one
   * storage area, which is a state Chrome never produces and which leaks unawaited writes into
   * whatever runs next.
   */
  terminateWorker(): void;
  /** Fire `chrome.runtime.onInstalled`. */
  triggerInstalled(reason?: string): void;
  /** Fire `chrome.runtime.onStartup`. */
  triggerStartup(): void;
  /** Fire `chrome.alarms.onAlarm` for one armed alarm. */
  triggerAlarm(name: string): void;
  /** Fire `chrome.commands.onCommand`, as a keyboard shortcut does. */
  triggerCommand(name: string): void;
  /** Fire `chrome.windows.onFocusChanged`. Pass `WINDOW_ID_NONE` (-1) for "Chrome lost focus". */
  triggerFocusChanged(windowId: number): void;
  /**
   * Fire `chrome.idle.onStateChanged`. Throws when the optional `idle` permission is not granted,
   * because Chrome does not expose `chrome.idle` at all in that case.
   */
  triggerIdleState(state: 'active' | 'idle' | 'locked'): void;
  /** Tabs created via `chrome.tabs.create`, in order. */
  readonly createdTabs: { url?: string; windowId?: number }[];
  /** The tabs `chrome.tabs.query` answers with. Replace the contents to change the active tab. */
  readonly openTabs: { id: number; url?: string; title?: string; active?: boolean }[];
  /** The windows `chrome.windows.getAll` answers with, plus everything `create` appended. */
  readonly openWindows: { id: number; incognito: boolean; type: string }[];
  /** What `chrome.extension.isAllowedIncognitoAccess()` answers. Off, as a fresh install is. */
  incognitoAccess: boolean;
  /** Context menus currently created, by id. `removeAll` empties it. */
  readonly menus: Map<string, { title?: string; contexts?: readonly string[] }>;
  /** Fire `chrome.contextMenus.onClicked`. */
  triggerMenuClick(info: { menuItemId: string; linkUrl?: string; selectionText?: string }): void;
  /** The toolbar badge's current text, as `chrome.action.setBadgeText` left it. */
  badgeText(): string;
  /** `chrome.idle.setDetectionInterval`'s last argument, or `undefined` if never called. */
  idleDetectionInterval(): number | undefined;
  /** Send a message the way a popup would, resolving with the first response given. */
  sendMessage(message: unknown): Promise<unknown>;
  /**
   * Register an extra `onMessage` listener, the way an open extension page does. Returns the
   * messages it received — which is how a test observes a broadcast from the service worker.
   */
  observeMessages(): unknown[];
}

export interface ChromeMockOptions {
  clock?: Clock;
  manifestVersion?: string;
  grantedPermissions?: readonly string[];
  /** Whether "Allow in Incognito" starts on. Off by default, as it is on a fresh install. */
  incognitoAccess?: boolean;
}

export function createChromeMock(options: ChromeMockOptions = {}): ChromeMock {
  const clock = options.clock ?? createClock();
  const onChanged = new Event<ChangeListener>();

  const emit = (changes: Record<string, StorageChange>, area: string): void => {
    for (const listener of onChanged.listeners) listener(changes, area);
  };

  const local = new StorageArea('local', { quotaBytes: LOCAL_LIMITS.QUOTA_BYTES }, clock, emit);
  const session = new StorageArea(
    'session',
    { quotaBytes: SESSION_LIMITS.QUOTA_BYTES },
    clock,
    emit,
  );
  const sync = new StorageArea(
    'sync',
    {
      quotaBytes: SYNC_LIMITS.QUOTA_BYTES,
      quotaBytesPerItem: SYNC_LIMITS.QUOTA_BYTES_PER_ITEM,
      maxItems: SYNC_LIMITS.MAX_ITEMS,
      maxWritesPerMinute: SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_MINUTE,
      maxWritesPerHour: SYNC_LIMITS.MAX_WRITE_OPERATIONS_PER_HOUR,
    },
    clock,
    emit,
  );

  type MessageListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
  ) => boolean | undefined;
  type AlarmListener = (alarm: { name: string; scheduledTime: number }) => void;
  type InstalledListener = (details: { reason: string }) => void;
  type StartupListener = () => void;
  type FocusListener = (windowId: number) => void;
  type CommandListener = (name: string) => void;
  type IdleListener = (state: 'active' | 'idle' | 'locked') => void;
  type MenuListener = (info: {
    menuItemId: string;
    linkUrl?: string;
    selectionText?: string;
  }) => void;

  const onMessage = new Event<MessageListener>();
  const onInstalled = new Event<InstalledListener>();
  const onStartup = new Event<StartupListener>();
  const onAlarm = new Event<AlarmListener>();
  const onFocusChanged = new Event<FocusListener>();
  const onCommand = new Event<CommandListener>();
  const onIdleStateChanged = new Event<IdleListener>();
  const onMenuClicked = new Event<MenuListener>();

  const grantedPermissions = new Set<string>([
    'storage',
    'activeTab',
    'scripting',
    'contextMenus',
    'alarms',
    'favicon',
    ...(options.grantedPermissions ?? []),
  ]);

  const createdWindows: { url?: string | string[]; incognito?: boolean }[] = [];
  const createdTabs: { url?: string; windowId?: number }[] = [];
  const openTabs: { id: number; url?: string; title?: string; active?: boolean }[] = [];
  const openWindows: { id: number; incognito: boolean; type: string }[] = [];
  const menus = new Map<string, { title?: string; contexts?: readonly string[] }>();
  const alarms = new Map<string, { periodInMinutes?: number; scheduledTime: number }>();
  let idleDetectionInterval: number | undefined;
  let incognitoAccess = options.incognitoAccess ?? false;
  let badgeText = '';

  const sendMessage = (message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      // Chrome's contract: the first `sendResponse` wins, and a listener that returns `true`
      // keeps the channel open to answer later. Resolving twice is a no-op, so the trailing
      // resolve only fires for messages nobody claimed.
      let asyncListener = false;
      for (const listener of onMessage.listeners) {
        if (listener(message, { id: EXTENSION_ID }, resolve) === true) asyncListener = true;
      }
      if (!asyncListener) resolve(undefined);
    });

  const api = {
    runtime: {
      id: EXTENSION_ID,
      lastError: undefined as { message: string } | undefined,
      getManifest: () => ({ version: options.manifestVersion ?? '0.0.0', manifest_version: 3 }),
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path.replace(/^\//, '')}`,
      sendMessage,
      onMessage,
      onInstalled,
      onStartup,
    },
    storage: {
      local,
      sync,
      session,
      onChanged,
    },
    alarms: {
      create: (
        name: string,
        info: { when?: number; delayInMinutes?: number; periodInMinutes?: number },
      ) => {
        const scheduledTime =
          info.when ?? clock.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000;
        alarms.set(
          name,
          info.periodInMinutes === undefined
            ? { scheduledTime }
            : { scheduledTime, periodInMinutes: info.periodInMinutes },
        );
        return Promise.resolve();
      },
      clear: (name: string) => Promise.resolve(alarms.delete(name)),
      clearAll: () => {
        alarms.clear();
        return Promise.resolve(true);
      },
      get: (name: string) => {
        const alarm = alarms.get(name);
        return Promise.resolve(alarm === undefined ? undefined : { name, ...alarm });
      },
      getAll: () => Promise.resolve([...alarms].map(([name, alarm]) => ({ name, ...alarm }))),
      onAlarm,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      create: (options_: { url?: string | string[]; incognito?: boolean }) => {
        createdWindows.push(options_);
        const window_ = {
          id: 1000 + createdWindows.length,
          incognito: options_.incognito ?? false,
          type: 'normal',
        };
        openWindows.push(window_);
        return Promise.resolve(window_);
      },
      getAll: (query?: { windowTypes?: string[] }) =>
        Promise.resolve(
          openWindows.filter(
            (window_) => query?.windowTypes === undefined || query.windowTypes.includes(window_.type),
          ),
        ),
      update: (windowId: number) => {
        const window_ = openWindows.find((candidate) => candidate.id === windowId);
        if (window_ === undefined) return Promise.reject(new Error(`No window with id ${windowId}`));
        return Promise.resolve(window_);
      },
      remove: () => Promise.resolve(),
      onFocusChanged,
    },
    tabs: {
      create: (options_: { url?: string; windowId?: number }) => {
        createdTabs.push(options_);
        return Promise.resolve({ id: createdTabs.length, url: options_.url });
      },
      // `activeTab` is what makes `url` and `title` readable here without a host permission, so a
      // tab whose grant is missing is modelled as one with no `url` — which is what Chrome does.
      query: (query: { active?: boolean }) =>
        Promise.resolve(
          openTabs.filter((tab) => query.active !== true || tab.active === true),
        ),
      remove: () => Promise.resolve(),
    },
    extension: {
      isAllowedIncognitoAccess: () => Promise.resolve(incognitoAccess),
    },
    contextMenus: {
      create: (properties: { id?: string; title?: string; contexts?: readonly string[] }) => {
        const id = properties.id ?? `generated-${menus.size}`;
        if (menus.has(id)) throw new Error(`Cannot create item with duplicate id ${id}`);
        menus.set(id, { ...(properties.title === undefined ? {} : { title: properties.title }),
          ...(properties.contexts === undefined ? {} : { contexts: properties.contexts }) });
        return id;
      },
      remove: (id: string) => {
        menus.delete(id);
        return Promise.resolve();
      },
      removeAll: () => {
        menus.clear();
        return Promise.resolve();
      },
      onClicked: onMenuClicked,
    },
    action: {
      setBadgeText: (details: { text?: string }) => {
        badgeText = details.text ?? '';
        return Promise.resolve();
      },
      getBadgeText: () => Promise.resolve(badgeText),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
    },
    commands: {
      getAll: () => Promise.resolve([]),
      onCommand,
    },
    // Present only when the optional `idle` permission has been granted (D26), because that is how
    // Chrome behaves: the namespace is simply absent, which is what `autolock.ts` checks for.
    ...(grantedPermissions.has('idle')
      ? {
          idle: {
            queryState: () => Promise.resolve('active' as const),
            setDetectionInterval: (seconds: number) => {
              idleDetectionInterval = seconds;
            },
            onStateChanged: onIdleStateChanged,
          },
        }
      : {}),
    permissions: {
      contains: (request: { permissions?: string[]; origins?: string[] }) =>
        Promise.resolve((request.permissions ?? []).every((name) => grantedPermissions.has(name))),
      request: (request: { permissions?: string[]; origins?: string[] }) => {
        for (const name of request.permissions ?? []) grantedPermissions.add(name);
        return Promise.resolve(true);
      },
      remove: (request: { permissions?: string[]; origins?: string[] }) => {
        for (const name of request.permissions ?? []) grantedPermissions.delete(name);
        return Promise.resolve(true);
      },
      getAll: () => Promise.resolve({ permissions: [...grantedPermissions], origins: [] }),
    },
    identity: {
      getAuthToken: () => Promise.resolve({ token: 'test-token', grantedScopes: [] }),
      removeCachedAuthToken: () => Promise.resolve(),
      launchWebAuthFlow: () => Promise.resolve(''),
    },
    i18n: {
      // Returning the key keeps assertions readable and makes a missing string obvious.
      getMessage: (key: string) => key,
    },
  };

  return {
    chrome: api as unknown as typeof chrome,
    clock,
    storage: { local, sync, session },
    grantedPermissions,
    createdWindows,
    createdTabs,
    openTabs,
    openWindows,
    menus,
    alarms,
    get incognitoAccess() {
      return incognitoAccess;
    },
    set incognitoAccess(allowed: boolean) {
      incognitoAccess = allowed;
    },
    badgeText: () => badgeText,
    terminateWorker: () => {
      for (const event of [
        onMessage,
        onInstalled,
        onStartup,
        onAlarm,
        onFocusChanged,
        onCommand,
        onIdleStateChanged,
        onMenuClicked,
      ]) {
        event.listeners.clear();
      }
    },
    triggerMenuClick: (info) => {
      for (const listener of onMenuClicked.listeners) listener(info);
    },
    triggerInstalled: (reason = 'install') => {
      for (const listener of onInstalled.listeners) listener({ reason });
    },
    triggerStartup: () => {
      for (const listener of onStartup.listeners) listener();
    },
    triggerAlarm: (name) => {
      const alarm = alarms.get(name);
      if (alarm === undefined) throw new Error(`no alarm named "${name}" is armed`);
      for (const listener of onAlarm.listeners)
        listener({ name, scheduledTime: alarm.scheduledTime });
    },
    triggerCommand: (name) => {
      for (const listener of onCommand.listeners) listener(name);
    },
    triggerFocusChanged: (windowId) => {
      for (const listener of onFocusChanged.listeners) listener(windowId);
    },
    triggerIdleState: (state) => {
      if (!grantedPermissions.has('idle')) {
        throw new Error('chrome.idle needs the optional "idle" permission');
      }
      for (const listener of onIdleStateChanged.listeners) listener(state);
    },
    idleDetectionInterval: () => idleDetectionInterval,
    sendMessage,
    observeMessages: () => {
      const received: unknown[] = [];
      onMessage.addListener((message) => {
        received.push(message);
        return undefined;
      });
      return received;
    },
  };
}

/** Install the mock as `globalThis.chrome`. Call `uninstallChromeMock()` in `afterEach`. */
export function installChromeMock(options: ChromeMockOptions = {}): ChromeMock {
  const mock = createChromeMock(options);
  (globalThis as { chrome?: typeof chrome }).chrome = mock.chrome;
  return mock;
}

export function uninstallChromeMock(): void {
  delete (globalThis as { chrome?: typeof chrome }).chrome;
}
