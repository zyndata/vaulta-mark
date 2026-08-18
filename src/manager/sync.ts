/**
 * The sync surfaces: the status button in the toolbar, the conflict banner, and the view where a
 * disagreement is settled.
 *
 * Three rules the design follows, all of them from ARCHITECTURE §6.5.
 *
 * - **A conflict blocks nothing.** The banner is persistent and non-modal, the rest of the vault
 *   stays usable, and the rest of the vault keeps syncing. Someone who does not want to deal with
 *   two versions of a bookmark right now should not have to.
 * - **Both versions are shown in full, side by side**, with the fields that actually disagree
 *   marked. A dialog that says "there was a conflict, pick one" and shows two dates is a dialog
 *   people resolve by guessing.
 * - **Nothing is ever pre-selected.** "Keep this device's" and "Keep the other one" sit next to each
 *   other with equal weight, because the machine has no idea which is right and pretending
 *   otherwise is how the wrong one gets clicked.
 */

import type { ConflictSide, ConflictView, SyncStatusResponse } from '../shared/messages.js';
import { h, msg } from '../ui/dom.js';
import { syncErrorText } from '../ui/strings.js';

/* ------------------------------------------------------------------ the status button */

export interface SyncStatusDeps {
  readonly status: SyncStatusResponse | null;
  readonly onSyncNow: () => void;
  /**
   * A run this window asked for is in flight.
   *
   * Needed on top of the phase, because the phase arrives by broadcast and the worker broadcasts
   * exactly once per attempt — at the end of it (`onStatus` in `sync/engine.ts`). So a press of this
   * button changed nothing on screen at all until the sync was already over: no busy label, no
   * disabled state, and when the answer finally came the relative time it printed was often the same
   * sentence it had been showing before ("Last synced just now", twice). Pressing something and
   * getting nothing back is how people conclude a button is broken and press it again.
   */
  readonly busy?: boolean;
}

const BUSY_PHASES = new Set(['peeking', 'pulling', 'merging', 'pushing']);

/**
 * The toolbar's sync control: what happened last, and a way to make it happen now.
 *
 * One element rather than a status line plus a button. The state *is* the affordance — a line that
 * says "last synced 3 minutes ago" is exactly the thing someone clicks when they want it to say
 * "just now".
 */
export function syncStatusButton(deps: SyncStatusDeps): HTMLElement {
  const status = deps.status;
  const busy = deps.busy === true || (status !== null && BUSY_PHASES.has(status.phase));
  const failure = busy ? null : (status?.error ?? null);

  const label = busy
    ? msg('syncBusy')
    : failure !== null
      ? syncErrorText(failure)
      : status?.lastSyncedAt == null
        ? msg('syncNever')
        : msg('syncLastSynced', [relativeTime(status.lastSyncedAt)]);

  return h(
    'button',
    {
      type: 'button',
      class: `vm-sync${failure === null ? '' : ' vm-sync--error'}${busy ? ' vm-sync--busy' : ''}`,
      disabled: busy,
      title: failure === null ? msg('syncNowButton') : syncErrorText(failure),
      onclick: deps.onSyncNow,
    },
    label,
  );
}

/**
 * "2 minutes ago", in the browser's language, without a translation string per unit.
 *
 * `Intl.RelativeTimeFormat` is a platform API, so this is not a user-facing string escaping
 * `_locales` — it is the platform's own phrasing, which is more likely to be right in a language
 * neither of us speaks than anything we would write.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const seconds = Math.round((at - now) / 1_000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(seconds, 'second');
}

/* ------------------------------------------------------------------ the quota bar */

/** Warn at 70 %, block new adds at 95 % (ARCHITECTURE §5.3). Mirrored from `storage/quota.ts`. */
const WARN_RATIO = 0.7;
const BLOCK_RATIO = 0.95;

/**
 * How full the sync tier is.
 *
 * A bar rather than a number, because the number that matters is not "42 kB" but "how much room is
 * left" — and because the honest answer to a vault that is 96 % of the way through a hard ceiling
 * is a red bar, not a sentence someone has to parse.
 */
export function syncQuotaBar(status: SyncStatusResponse): HTMLElement {
  const ratio = status.quotaBytes === 0 ? 0 : status.usedBytes / status.quotaBytes;
  const level = ratio >= BLOCK_RATIO ? 'full' : ratio >= WARN_RATIO ? 'warn' : 'ok';

  return h(
    'div',
    { class: 'vm-quota' },
    h(
      'div',
      {
        class: `vm-quota-track vm-quota-track--${level}`,
        role: 'meter',
        'aria-label': msg('syncQuotaLabel'),
        'aria-valuemin': 0,
        'aria-valuemax': status.quotaBytes,
        'aria-valuenow': status.usedBytes,
        'aria-valuetext': msg('syncQuotaUsed', [
          storageSize(status.usedBytes),
          storageSize(status.quotaBytes),
        ]),
      },
      h('div', {
        class: 'vm-quota-fill',
        style: `width: ${String(Math.min(100, Math.round(ratio * 100)))}%`,
      }),
    ),
    h(
      'p',
      { class: 'vm-small vm-muted' },
      msg('syncQuotaUsed', [storageSize(status.usedBytes), storageSize(status.quotaBytes)]),
    ),
    level === 'ok'
      ? null
      : h(
          'p',
          { class: `vm-notice${level === 'full' ? ' vm-notice--danger' : ''}` },
          msg(level === 'full' ? 'syncQuotaFull' : 'syncQuotaWarn'),
        ),
  );
}

/** The three units a storage figure is ever shown in, largest first. */
const SIZE_UNITS: readonly { readonly unit: 'gigabyte' | 'megabyte' | 'kilobyte'; readonly scale: number }[] = [
  { unit: 'gigabyte', scale: 1024 ** 3 },
  { unit: 'megabyte', scale: 1024 ** 2 },
  { unit: 'kilobyte', scale: 1024 },
];

/**
 * A byte count, in the largest unit that leaves it readable.
 *
 * It used to be kilobytes and only kilobytes, which was fine while the only backend was
 * `chrome.storage.sync` and the ceiling was 100 KB. Drive's is fifteen *gigabytes*, and the same
 * function rendered that as `6010430 kB of 15728640 kB used` — seven- and eight-digit numbers with
 * no separators, which is not a quantity anybody reads, it is a quantity people scan past.
 *
 * `Intl.NumberFormat`'s `unit` style rather than a suffix per unit in `_locales`: it is the
 * platform's own phrasing and grouping, in the browser's language, and the same reasoning as
 * {@link relativeTime} above — a unit abbreviation is not a sentence we should be translating.
 *
 * The divisor is 1024 throughout, which is what makes the total agree with what Google itself shows:
 * a "15 GB" Drive is 16,106,127,360 bytes.
 */
export function storageSize(bytes: number): string {
  const chosen = SIZE_UNITS.find((candidate) => bytes >= candidate.scale) ?? {
    unit: 'kilobyte' as const,
    scale: 1024,
  };
  const value = bytes / chosen.scale;
  return new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit: chosen.unit,
    unitDisplay: 'short',
    // One decimal only where it carries information. "5.7 GB" is worth a digit; "5,870 MB" is not,
    // and "0.1 kB" for an empty vault would be precision about nothing.
    maximumFractionDigits: value < 10 && bytes >= 1024 ? 1 : 0,
  }).format(value);
}

/* ------------------------------------------------------------------ the banner */

export function conflictBanner(count: number, onReview: () => void): HTMLElement {
  return h(
    'div',
    { class: 'vm-conflict-banner', role: 'status' },
    h('span', null, count === 1 ? msg('conflictBannerOne') : msg('conflictBannerMany', [String(count)])),
    h(
      'button',
      { type: 'button', class: 'vm-button vm-button--inline', onclick: onReview },
      msg('conflictReview'),
    ),
  );
}

/* ------------------------------------------------------------------ the conflict view */

export interface ConflictViewDeps {
  readonly conflicts: readonly ConflictView[];
  readonly resolve: (ids: readonly string[], resolution: 'mine' | 'theirs' | 'both') => void;
  readonly onBack: () => void;
}

export function conflictScreen(deps: ConflictViewDeps): HTMLElement {
  const ids = deps.conflicts.map((conflict) => conflict.id);
  return h(
    'section',
    { class: 'vm-conflicts', 'aria-label': msg('conflictHeading') },
    h('h2', null, msg('conflictHeading')),
    h('p', { class: 'vm-muted' }, msg('conflictIntro')),
    h(
      'div',
      { class: 'vm-conflict-actions', role: 'toolbar', 'aria-label': msg('conflictHeading') },
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          disabled: ids.length === 0,
          onclick: () => {
            deps.resolve(ids, 'mine');
          },
        },
        msg('conflictKeepAllMine'),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'vm-button vm-button--quiet vm-button--inline',
          disabled: ids.length === 0,
          onclick: () => {
            deps.resolve(ids, 'theirs');
          },
        },
        msg('conflictKeepAllTheirs'),
      ),
      h(
        'button',
        { type: 'button', class: 'vm-button vm-button--inline', onclick: deps.onBack },
        msg('conflictBack'),
      ),
    ),
    deps.conflicts.length === 0
      ? h('p', { class: 'vm-placeholder' }, msg('conflictNone'))
      : h('ul', { class: 'vm-conflict-list' }, ...deps.conflicts.map((conflict) => card(conflict, deps))),
  );
}

function card(conflict: ConflictView, deps: ConflictViewDeps): HTMLElement {
  const disagreeing = new Set(conflict.fields);
  return h(
    'li',
    { class: 'vm-conflict' },
    h('h3', null, conflict.mine.title === '' ? conflict.theirs.title : conflict.mine.title),
    h(
      'div',
      { class: 'vm-conflict-sides' },
      sideColumn('conflictMine', conflict.mine, disagreeing),
      sideColumn('conflictTheirs', conflict.theirs, disagreeing),
    ),
    h(
      'div',
      { class: 'vm-conflict-choices' },
      choice('conflictKeepMine', () => {
        deps.resolve([conflict.id], 'mine');
      }),
      choice('conflictKeepTheirs', () => {
        deps.resolve([conflict.id], 'theirs');
      }),
      conflict.canKeepBoth
        ? choice('conflictKeepBoth', () => {
            deps.resolve([conflict.id], 'both');
          })
        : null,
    ),
  );
}

function choice(labelKey: string, onClick: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'vm-button vm-button--quiet vm-button--inline', onclick: onClick },
    msg(labelKey),
  );
}

/** Which stored field a displayed row corresponds to, so the marking follows the merge engine. */
const ROWS: readonly { readonly labelKey: string; readonly field: string; readonly read: (side: ConflictSide) => string }[] = [
  { labelKey: 'conflictFieldUrl', field: 'url', read: (side) => side.url ?? '' },
  { labelKey: 'conflictFieldNote', field: 'note', read: (side) => side.note },
  { labelKey: 'conflictFieldTags', field: 'tags', read: (side) => side.tags.join(', ') },
  { labelKey: 'conflictFieldFolder', field: 'parentId', read: (side) => side.folder },
];

function sideColumn(
  headingKey: string,
  side: ConflictSide,
  disagreeing: ReadonlySet<string>,
): HTMLElement {
  if (side.deleted) {
    return h(
      'div',
      { class: 'vm-conflict-side vm-conflict-side--deleted' },
      h('h4', null, msg(headingKey)),
      h('p', { class: 'vm-muted' }, msg('conflictDeletedSide')),
    );
  }
  return h(
    'div',
    { class: 'vm-conflict-side' },
    h('h4', null, msg(headingKey)),
    field('conflictFieldTitle', side.title, disagreeing.has('title')),
    ...ROWS.filter((row) => row.read(side) !== '').map((row) =>
      field(row.labelKey, row.read(side), disagreeing.has(row.field)),
    ),
  );
}

function field(labelKey: string, value: string, changed: boolean): HTMLElement {
  return h(
    'div',
    { class: `vm-conflict-field${changed ? ' is-changed' : ''}` },
    h('span', { class: 'vm-small vm-muted' }, msg(labelKey)),
    h('span', { class: 'vm-conflict-value' }, value),
  );
}
