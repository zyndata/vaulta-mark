/**
 * The vault schema (ARCHITECTURE §3) — the shapes that go into ciphertext, plus the plaintext
 * header that has to sit outside it.
 *
 * This file is types and constants only. It is the one place a reader can go to learn what a vault
 * *is*, so the behaviour lives next door in `model.ts` and the storage layer, not here.
 *
 * **`SCHEMA_VERSION` is 2 from day one.** v1 is reserved as "pre-tags/notes/thumbs" so the
 * migration machinery in `migrate.ts` is exercised by a real fixture rather than being dead code
 * that first runs in the field.
 */

import type { Bytes } from '../crypto/codec.js';
import type { SyncedSettings } from './settings-sync.js';

/** Bumped whenever the decrypted payload shape changes. A bump needs a migration and a fixture. */
export const SCHEMA_VERSION = 2;

/** Header sentinel. Cheap, and it makes "this is not a VaultaMark vault" a clear failure. */
export const VAULT_MAGIC = 'VAULTAMARK';

/** The synthetic parent of every top-level item. Never itself stored as an item. */
export const ROOT_ID = 'root';

/** Bucket count a fresh vault starts with (ARCHITECTURE §5.4). Doubles on rebalance. */
export const DEFAULT_BUCKET_COUNT = 16;

/** How long a tombstone is kept before it may be purged (D20). */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Normalization caps from ARCHITECTURE §3.5. */
export const MAX_TAGS_PER_ITEM = 32;
export const MAX_TAG_LENGTH = 64;
/** Soft cap: longer notes are truncated rather than rejected — nobody should lose typing. */
export const MAX_NOTE_LENGTH = 4096;

/**
 * The plaintext vault header (ARCHITECTURE §3.1).
 *
 * It **must** be plaintext: the KDF parameters are what we need in order to derive the key, so they
 * cannot themselves be behind the key. It leaks that a vault exists, roughly how big it is, and how
 * often it changes. It leaks nothing about contents — `BucketMeta.tag` is a keyed HMAC precisely so
 * an observer cannot confirm a guessed bucket content offline.
 */
export interface VaultHeader {
  readonly magic: typeof VAULT_MAGIC;
  readonly schemaVersion: number;
  readonly kdf: {
    readonly alg: 'PBKDF2-HMAC-SHA256';
    readonly iterations: number;
    /** base64url, 32 bytes, random per vault. */
    readonly salt: string;
  };
  /** AES-256-GCM(KEK, DEK): 12-byte IV, 48-byte ciphertext-plus-tag, both base64url. */
  readonly wrappedDek: { readonly iv: string; readonly ct: string };
  /** Monotonic; incremented once per committed change. */
  readonly vaultRev: number;
  readonly bucketCount: number;
  readonly buckets: readonly BucketMeta[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Random per install. Used only to label the sides of a merge conflict (Phase 7). */
  readonly deviceId: string;
}

export interface BucketMeta {
  /** Bucket index, `0 <= i < bucketCount`. */
  readonly i: number;
  /** `vaultRev` at which this bucket last changed. */
  readonly rev: number;
  /** How many provider items this bucket occupies. `0` means the bucket is empty and unstored. */
  readonly parts: number;
  /** base64url of `HMAC-SHA256(k_hmac, canonical payload JSON)[0..8]`. */
  readonly tag: string;
}

/**
 * What one bucket decrypts to.
 *
 * `settings` rides in **bucket 0 only** and is the synced half of `vm.settings` (Phase 10,
 * `settings-sync.ts`). It is an additive, optional field rather than a schema bump: an older build
 * reads the bucket, ignores the key and works exactly as before, and there is no item shape for a
 * migration to change. What it does affect is bucket 0's plaintext tag, which is the point —
 * changing a theme dirties one bucket and syncs like any other edit.
 */
export interface BucketPayload {
  readonly items: readonly VaultItem[];
  readonly settings?: SyncedSettings;
}

/** The bucket the synced settings record lives in. Bucket 0 exists in every vault (§5.4). */
export const SETTINGS_BUCKET = 0;

/**
 * A whole vault as ciphertext: the plaintext header, and the sealed bytes of every stored bucket.
 *
 * This is the only shape that crosses the `SyncProvider` boundary (ARCHITECTURE §6.1). A provider
 * moves these bytes and never sees a key — which is what lets a backend be added without any of it
 * being security-relevant. Buckets with `parts: 0` in the header are absent from the map: an empty
 * bucket is not stored, on either side.
 */
export interface EncryptedVault {
  readonly header: VaultHeader;
  readonly buckets: ReadonlyMap<number, Bytes>;
}

export type VaultItem = Bookmark | Folder;

export interface ItemBase {
  /** UUID v4, stable for the item's lifetime — it is also what decides the item's bucket. */
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Fractional index among siblings — see `order.ts`. */
  readonly order: string;
  /** `vaultRev` at this item's last change. */
  readonly rev: number;
  /** Tombstone. Present only when the item is deleted; never `false`. */
  readonly deleted?: true;
  readonly deletedAt?: number;
}

export interface Bookmark extends ItemBase {
  readonly type: 'bookmark';
  readonly url: string;
  readonly note?: string;
  readonly tags?: readonly string[];
  readonly openedAt?: number;
  readonly openCount?: number;
  readonly og?: { readonly title?: string; readonly description?: string };
  readonly thumb?: ThumbMeta;
}

export interface Folder extends ItemBase {
  readonly type: 'folder';
}

export interface ThumbMeta {
  /** SHA-256 of the *plaintext* thumbnail bytes: integrity, and dedupe across items. */
  readonly sha256: string;
  readonly w: number;
  readonly h: number;
  /** Encrypted size, so a quota estimate needs no decryption. */
  readonly bytes: number;
  readonly src: 'og' | 'twitter';
  readonly at: number;
  readonly driveId?: string;
}

/** Items by id. The working shape everywhere above the storage layer. */
export type ItemMap = ReadonlyMap<string, VaultItem>;

export function isBookmark(item: VaultItem): item is Bookmark {
  return item.type === 'bookmark';
}

export function isFolder(item: VaultItem): item is Folder {
  return item.type === 'folder';
}

/** A tombstone is an item that still exists in the payload so a delete can outlive a stale peer. */
export function isDeleted(item: VaultItem): boolean {
  return item.deleted === true;
}

/**
 * Tags of an item, defaulted.
 *
 * Absent and empty mean the same thing, and every item paying for `"tags":[]` in the ciphertext
 * costs real bytes against a 100 KB sync quota. Read through this rather than touching `.tags`.
 */
export function tagsOf(item: VaultItem): readonly string[] {
  return (isBookmark(item) ? item.tags : undefined) ?? [];
}

/** Note of an item, defaulted. Same reasoning as {@link tagsOf}. */
export function noteOf(item: VaultItem): string {
  return (isBookmark(item) ? item.note : undefined) ?? '';
}

/**
 * The orders the manager's list can be in.
 *
 * The names live here rather than in `sort.ts` because `VaultSettings` below needs them, and
 * `sort.ts` needs the item types from this file — putting them there would make the two modules
 * import each other. The *comparators* are in `sort.ts`; this is only the vocabulary.
 *
 * `manual` (Phase 12) is the one that is not derived from a field of the item: it reads
 * {@link ItemBase.order}, the fractional index the model has maintained since Phase 3 and which
 * until now nothing ever displayed. It is what makes dragging a bookmark to a *position* mean
 * anything — under any of the other five, a list rearranges itself the instant it reloads and a
 * drop between two rows would be a gesture with no effect and no explanation.
 */
export const SORT_KEYS = ['added', 'modified', 'title', 'opened', 'opens', 'manual'] as const;

export type SortKey = (typeof SORT_KEYS)[number];

/** What a fresh install sorts by: the bookmark you saved a minute ago is the one you want. */
export const DEFAULT_SORT: SortKey = 'added';

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Non-sensitive settings (`vm.settings`, ARCHITECTURE §5.1).
 *
 * Deliberately plaintext, and deliberately incapable of holding vault content: the lock screen has
 * to honour the theme, and the auto-lock alarm has to be armed, before any key exists. Anything
 * that describes a *bookmark* belongs in the ciphertext and must never appear here.
 */
export interface VaultSettings {
  readonly theme: 'system' | 'light' | 'dark';
  /** Auto-lock idle window, in minutes. {@link IDLE_TIMEOUT_NEVER} disables it. */
  readonly idleTimeoutMinutes: number;
  readonly providerId: 'chrome' | 'drive';
  readonly lockOnBrowserBlur: boolean;
  /** Strip UTM parameters when saving a URL. On by default (ARCHITECTURE §3.5). */
  readonly stripTrackingParams: boolean;
  /** Open vaulted links in the incognito window that is already open, if there is one (§9). */
  readonly reuseIncognitoWindow: boolean;
  /**
   * Clear history for every vaulted domain each time the vault locks (§12.2). Off by default.
   *
   * A boolean about behaviour, not about a bookmark: the *domains* it acts on are derived from the
   * decrypted vault at the moment it runs and never written down, which is what keeps a feature
   * whose whole subject is "which sites are in your vault" on the right side of INV-6.
   */
  readonly clearHistoryOnLock: boolean;
  /** Ctrl+Shift+X closes the tab and deletes that domain's history (§12.3). Off by default. */
  readonly quickClose: boolean;
  /**
   * Capture preview images on a backend that cannot store them — "keep thumbnails on this device
   * only" (§14.4). Off by default, and meaningless while Drive is connected, where the heavy tier
   * captures regardless.
   *
   * Deliberately **not** in `SYNCED_SETTING_KEYS`: it is a statement about this computer's disk, and
   * a laptop should not inherit a desktop's answer to it — the same reasoning as the column widths.
   */
  readonly localThumbnails: boolean;
  /**
   * Whether the offer above has been made. Set once, either way it was answered (§14.4).
   *
   * A record of a question having been asked, not a preference — but it lives here because the
   * alternative is a tenth `storage.local` key holding one boolean, and it is per-device for the
   * same reason {@link localThumbnails} is.
   */
  readonly thumbnailsOffered: boolean;
  /**
   * The order the manager's list is in.
   *
   * One setting for the whole manager rather than one per folder, and that is a privacy decision
   * rather than a simplification: a per-folder preference has to be keyed by folder id, and this
   * file is written to `vm.settings` in the clear (§5.1). A map of folder ids in plaintext would
   * leak how many folders a vault has and how often each is visited — small, but it is exactly the
   * kind of shape INV-6 exists to keep out of `storage.local`.
   */
  readonly sortBy: SortKey;
  /**
   * Widths of the manager's two side columns, in CSS pixels.
   *
   * Two numbers about the window's furniture, not about its contents: a column width describes the
   * screen, not a bookmark, which is what keeps it on the right side of INV-6 where a per-folder
   * preference is not. Stored so a resized window opens the way it was left.
   */
  readonly sidebarWidth: number;
  readonly detailWidth: number;
}

/** Bounds and starting width for a resizable manager column, in CSS pixels. */
export interface PaneWidth {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

/** Wide enough for a folder tree with a few levels of nesting, narrow enough to leave a list. */
export const SIDEBAR_WIDTH: PaneWidth = { min: 160, max: 520, initial: 264 };

/** The detail pane is a form: it needs room for a URL and a note without wrapping every line. */
export const DETAIL_WIDTH: PaneWidth = { min: 240, max: 720, initial: 384 };

/**
 * A pane width, forced into range.
 *
 * Applied on the way in *and* on the way out: a stored width is only as trustworthy as the last
 * thing that wrote it, and a column of −4,000 px is a manager nobody can use without clearing
 * storage.
 */
export function clampPaneWidth(value: number, bounds: PaneWidth): number {
  if (!Number.isFinite(value)) return bounds.initial;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

/**
 * "Never auto-lock." Still not "stay unlocked forever": `chrome.storage.session` is memory-backed
 * and clears when the browser exits, so the vault locks on restart whatever this is set to (D14).
 */
export const IDLE_TIMEOUT_NEVER = 0;

/** The idle windows the UI offers, in minutes. `10` is the default. */
export const IDLE_TIMEOUT_CHOICES = [1, 5, 10, 30, 60, IDLE_TIMEOUT_NEVER] as const;

export const DEFAULT_SETTINGS: VaultSettings = {
  theme: 'system',
  idleTimeoutMinutes: 10,
  providerId: 'chrome',
  // Off by default. It fires on *focus loss* — every switch to another application, not just
  // closing Chrome — which at 600,000 PBKDF2 iterations means retyping the master password every
  // alt-tab. That is a posture worth offering and a bad one to impose; the idle timeout already
  // covers walking away. Opt in from the popup.
  lockOnBrowserBlur: false,
  // On by default. The parameters it drops are campaign and click identifiers — none of them
  // changes which page a URL resolves to — and a vault full of `?utm_source=newsletter` is a vault
  // where the same page saved twice from two mailings looks like two bookmarks. Turning it on
  // afterwards offers to clean what is already saved (`organize.trackingCleanup`); turning it off
  // is one toggle away, and nothing already saved is touched by that.
  stripTrackingParams: true,
  // On by default. Every vaulted link landing in the same incognito window is what people expect
  // from "open in incognito"; a new window per bookmark buries the browser in windows, and each of
  // them is a separate incognito session that has to be closed separately to end it.
  reuseIncognitoWindow: true,
  // Both off by default, and both stay off until someone reads what they do. They are the two
  // settings in this file that delete data outside the vault: one erases the browsing history of
  // every site the vault knows about on every lock, the other erases a whole domain's history on a
  // keystroke. Neither is a default anyone should discover by accident (§12.2, §12.3).
  clearHistoryOnLock: false,
  quickClose: false,
  // Off, and nothing is captured or injected until it is on (§14.4). Capturing pictures that can
  // never leave one computer would make the same vault look different on every device for a reason
  // nobody asked for — so it is offered, in context, once, and left alone after that.
  localThumbnails: false,
  thumbnailsOffered: false,
  sortBy: DEFAULT_SORT,
  sidebarWidth: SIDEBAR_WIDTH.initial,
  detailWidth: DETAIL_WIDTH.initial,
};

/**
 * `vm.baseMeta` — the plaintext bookkeeping beside the encrypted merge base.
 *
 * Deliberately contentless: a revision number, a provider id, a timestamp and a hash of the remote
 * *header*. It is read before the vault is unlocked, so a lock screen can say when the vault last
 * synced without a key — which is only defensible because none of it describes a bookmark.
 */
export interface BaseMeta {
  readonly lastSyncedRev: number;
  readonly providerId: VaultSettings['providerId'];
  readonly syncedAt: number;
  /**
   * `contentHash` of the remote stamp this base was written against.
   *
   * `lastSyncedRev` on its own cannot answer "has the remote moved?": two devices can both reach
   * revision 7 with different contents, and a revision number that matches would then wave a
   * genuinely divergent remote straight past the merge.
   */
  readonly remoteHash: string;
}

/**
 * `vm.rollbackMeta` — the plaintext note beside the replace-import undo snapshot (Phase 8).
 *
 * Two timestamps, deliberately nothing else, for the same reason {@link BaseMeta} carries nothing:
 * it sits in the clear in `storage.local`, and "how many bookmarks were in the vault before the
 * import" is a fact about the vault's contents. The UI that needs a count has the snapshot open.
 */
export interface RollbackMeta {
  readonly createdAt: number;
  /** Epoch ms after which the snapshot is refused and discarded. 24 hours (§11). */
  readonly expiresAt: number;
}

/** How long a replace-import's one-shot undo survives (ARCHITECTURE §11). */
export const ROLLBACK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `vm.onboarding` — how far the first-run flow got (Phase 9).
 *
 * Plaintext, and contentless in the same way {@link BaseMeta} is: a step number, two booleans and a
 * timestamp. It has to be readable before there is a vault at all — the whole point of the flow is
 * that it runs *before* a password exists — so it could not be inside the ciphertext even if it
 * described something, and it deliberately describes nothing but the flow itself.
 */
export interface OnboardingRecord {
  /** When the flow was finished, or `null` while it has not been. */
  readonly completedAt: number | null;
  /** The step to resume on, 0-based. A closed tab should not mean starting over. */
  readonly step: number;
  /**
   * The user chose "skip for now" on the incognito step.
   *
   * Kept after completion on purpose: it is what puts the persistent nudge in the manager, and the
   * nudge is the only thing left reminding someone that half the product is switched off.
   */
  readonly incognitoSkipped: boolean;
}

export const DEFAULT_ONBOARDING: OnboardingRecord = {
  completedAt: null,
  step: 0,
  incognitoSkipped: false,
};
