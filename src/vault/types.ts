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

/** What one bucket decrypts to. */
export interface BucketPayload {
  readonly items: readonly VaultItem[];
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
  /** Strip UTM parameters when saving a URL. Off by default (ARCHITECTURE §3.5). */
  readonly stripTrackingParams: boolean;
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
  stripTrackingParams: false,
};

/** `vm.baseMeta` — the plaintext bookkeeping beside the encrypted merge base. Phase 7 uses it. */
export interface BaseMeta {
  readonly lastSyncedRev: number;
  readonly providerId: VaultSettings['providerId'];
  readonly syncedAt: number;
}
