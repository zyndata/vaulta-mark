/**
 * `VaultRepository` — the domain API for an encrypted vault on `storage.local`.
 *
 * Everything above this line (the service worker, the popup, the manager) talks to the vault
 * through this object and never sees a key, a bucket, or a byte of ciphertext. Everything below it
 * is pure or byte-level. The interesting parts:
 *
 * - **Unlock decrypts once.** Items live in memory as an `ItemMap` while unlocked, so `getAll()`
 *   and search are synchronous and the UI never waits on crypto to paint a list.
 * - **Writes are dirty-tracked and coalesced.** A mutation marks the buckets its changed items
 *   belong to and returns; 300 ms later — or on the next `flush()` — only those buckets are
 *   re-sealed and written. Typing a note is one write, not one per keystroke.
 * - **Buckets are written before the header, always.** A crash between the two leaves a header
 *   pointing at the previous revision of a bucket that has already been superseded, which the
 *   integrity tag detects; the other order leaves a header pointing at buckets that do not exist.
 * - **Lock forgets everything.** The DEK, the subkeys, the items and the search index all go. What
 *   `lock()` cannot do is prove the bytes are unrecoverable — see `crypto/wipe.ts`.
 *
 * Key custody above this line belongs to `background/session.ts`, which keeps the DEK in
 * `chrome.storage.session` so it survives the service worker being killed every ~30 seconds (D14).
 * This file has no `storage.session` knowledge: it hands the raw key out through `exportDek()` and
 * takes one back through `unlockWithDek()`, and knows nothing about where it was kept in between.
 */

import { fromBase64Url, toBase64Url, type Bytes } from '../crypto/codec.js';
import { CorruptVaultError, UnsupportedSchemaError } from '../crypto/errors.js';
import { RECOMMENDED_KDF_PARAMS, deriveKek, generateKdfSalt } from '../crypto/kdf.js';
import { generateDek, subkey, unwrapDek, wrapDek } from '../crypto/keys.js';
import { MIN_PASSWORD_LENGTH, passwordLength } from '../crypto/password.js';
import { Secret } from '../crypto/wipe.js';
import { VaultLockedError, VaultStateError, WeakPasswordError } from '../vault/errors.js';
import { migrate, needsMigration } from '../vault/migrate.js';
import { applyMutations, purgeTombstones, toItemMap, type Mutation } from '../vault/model.js';
import {
  buildSearchIndex,
  search,
  type SearchHit,
  type SearchIndex,
  type SearchOptions,
} from '../vault/search.js';
import {
  DEFAULT_BUCKET_COUNT,
  SCHEMA_VERSION,
  TOMBSTONE_TTL_MS,
  VAULT_MAGIC,
  isDeleted,
  type BucketMeta,
  type BucketPayload,
  type ItemMap,
  type VaultHeader,
  type VaultItem,
} from '../vault/types.js';
import { bucketOf } from './buckets.js';
import { bucketTag, openBucket, sealBucket } from './codec.js';
import { clearVault, readBuckets, readHeader, writeBuckets, writeHeader } from './local.js';
import { partsFor } from './quota.js';

/** How long writes are held back so a burst of edits becomes one write. */
export const WRITE_COALESCE_MS = 300;

export interface VaultRepositoryOptions {
  /** Injected so tests get a deterministic clock. */
  readonly now?: () => number;
  /** Injected so tests get deterministic item ids. */
  readonly newId?: () => string;
  readonly coalesceMs?: number;
}

export interface GetAllOptions {
  /** Include tombstones. Off by default — a deleted bookmark must not appear anywhere in the UI. */
  readonly includeDeleted?: boolean;
}

export class VaultRepository {
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #coalesceMs: number;

  #header: VaultHeader | null = null;
  #dek: Secret<Bytes> | null = null;
  #itemsKey: CryptoKey | null = null;
  #hmacKey: CryptoKey | null = null;

  #items: ItemMap = new Map();
  /** Item id → bucket index. Cached because it costs a SHA-256 and never changes for an id. */
  #bucketByItem = new Map<string, number>();
  #dirtyBuckets = new Set<number>();
  #headerDirty = false;
  #index: SearchIndex | null = null;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #flushing: Promise<void> | null = null;
  /** A write that failed on the coalescing timer, re-thrown at the next call the caller awaits. */
  #deferredError: unknown = null;

  constructor(options: VaultRepositoryOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#coalesceMs = options.coalesceMs ?? WRITE_COALESCE_MS;
  }

  get locked(): boolean {
    return this.#dek === null;
  }

  /** Whether this profile already holds a vault. Cheap: reads the plaintext header only. */
  async exists(): Promise<boolean> {
    return (await readHeader()) !== null;
  }

  /** The plaintext header. Available only while unlocked, because nothing else needs it. */
  header(): VaultHeader {
    if (this.#header === null) throw new VaultLockedError('reading the vault header');
    return this.#header;
  }

  /* ---------------------------------------------------------------- lifecycle */

  /**
   * Create a vault and leave it unlocked.
   *
   * There is no password verifier and no recovery (D12): the wrapped DEK *is* the check, and
   * nothing stored here could be used to recover the password later even if we wanted it to be.
   */
  async create(password: string): Promise<void> {
    this.#throwDeferred();
    if (await this.exists()) {
      throw new VaultStateError('This profile already holds a vault; destroy it before creating.');
    }
    assertPasswordLength(password);

    const salt = generateKdfSalt();
    const kek = await deriveKek(password, salt, RECOMMENDED_KDF_PARAMS);
    const dek = generateDek();
    const wrappedDek = await wrapDek(kek, dek);

    await this.#adoptKeys(dek);
    const now = this.#now();
    const emptyTag = await bucketTag(this.#requireHmacKey(), { items: [] });

    this.#header = {
      magic: VAULT_MAGIC,
      schemaVersion: SCHEMA_VERSION,
      kdf: { ...RECOMMENDED_KDF_PARAMS, salt: toBase64Url(salt) },
      wrappedDek,
      vaultRev: 1,
      bucketCount: DEFAULT_BUCKET_COUNT,
      buckets: emptyBucketTable(DEFAULT_BUCKET_COUNT, 1, emptyTag),
      createdAt: now,
      updatedAt: now,
      // Not `#newId`: that is the *item* id source, and drawing from it here would shift every
      // subsequent item id by one — invisible in production, and a trap in any test that injects
      // a deterministic generator. A device label never needs to be reproducible.
      deviceId: crypto.randomUUID(),
    };
    this.#items = new Map();
    this.#bucketByItem = new Map();
    this.#index = null;

    // No buckets are stored for an empty vault: `parts: 0` in the header says so, and writing
    // sixteen sealed empty payloads would cost ~7 KB of a 100 KB sync quota to say nothing.
    await writeHeader(this.#header);
  }

  /**
   * Unlock with the master password and decrypt every bucket into memory.
   *
   * A wrong password surfaces as `WrongPasswordError` from `unwrapDek`; damaged bytes surface as
   * `CorruptVaultError`; a vault from a newer build surfaces as `UnsupportedSchemaError` *before*
   * any key is derived, so the user is told to update rather than told their password is wrong.
   */
  async unlock(password: string): Promise<void> {
    this.#throwDeferred();
    const header = await this.#readUnlockableHeader();
    const kek = await deriveKek(password, fromBase64Url(header.kdf.salt), {
      alg: header.kdf.alg,
      iterations: header.kdf.iterations,
    });
    const dek = await unwrapDek(kek, header.wrappedDek);
    await this.#open(header, dek);
  }

  /**
   * Unlock from a DEK that is already in hand, skipping the KDF entirely.
   *
   * This is how an MV3 service worker survives being killed (ARCHITECTURE §7): the unlocked DEK
   * lives in `chrome.storage.session`, and a restarted worker rebuilds the repository from it
   * rather than asking for the master password every thirty seconds. There is deliberately no
   * password check — there is nothing to check against, and possession of the DEK *is* the
   * authorization. It reaches here only from a `storage.session` entry this extension wrote after
   * a real unlock, in a storage area that is memory-backed and restricted to trusted contexts.
   *
   * The bytes are copied: the caller keeps ownership of its buffer and is expected to zero it.
   */
  async unlockWithDek(dek: Bytes): Promise<void> {
    this.#throwDeferred();
    const header = await this.#readUnlockableHeader();
    await this.#open(header, new Uint8Array(dek));
  }

  /**
   * A copy of the raw DEK, for `chrome.storage.session` custody (D14).
   *
   * A copy rather than the live buffer, so a caller zeroing what it was given cannot pull the key
   * out from under a repository that is still using it. The DEK is raw bytes rather than a
   * `CryptoKey` precisely because it has to survive in `storage.session`, which a `CryptoKey` does
   * not serialise into (ARCHITECTURE §4.1).
   */
  exportDek(): Bytes {
    const dek = this.#dek;
    if (dek === null) throw new VaultLockedError('exporting the data key');
    return new Uint8Array(dek.value);
  }

  async #readUnlockableHeader(): Promise<VaultHeader> {
    const header = await readHeader();
    if (header === null) {
      throw new VaultStateError('There is no vault on this profile to unlock.');
    }
    if (header.schemaVersion > SCHEMA_VERSION) {
      throw new UnsupportedSchemaError(header.schemaVersion, SCHEMA_VERSION);
    }
    return header;
  }

  /** Adopt a DEK and decrypt every stored bucket into memory. Takes ownership of `dek`. */
  async #open(header: VaultHeader, dek: Bytes): Promise<void> {
    await this.#adoptKeys(dek);

    const stored = header.buckets.filter((meta) => meta.parts > 0).map((meta) => meta.i);
    const sealed = await readBuckets(stored);
    const raw: Record<string, unknown>[] = [];
    for (const meta of header.buckets) {
      if (meta.parts === 0) continue;
      const bytes = sealed.get(meta.i);
      if (bytes === undefined) {
        throw new CorruptVaultError(`Vault header lists bucket ${meta.i}, which is not stored.`);
      }
      const payload = await openBucket(
        this.#requireItemsKey(),
        this.#requireHmacKey(),
        meta.i,
        bytes,
        meta.tag,
      );
      raw.push(...payload.items);
    }

    const migrated = migrate({ items: raw }, header.schemaVersion);
    this.#items = toItemMap(migrated.items);
    this.#bucketByItem = new Map();
    for (const item of this.#items.values()) {
      this.#bucketByItem.set(item.id, await bucketOf(item.id, header.bucketCount));
    }
    this.#index = null;

    if (needsMigration(header.schemaVersion)) {
      // Migrated in memory; written back on the next commit rather than now, so opening a vault
      // read-only never rewrites it (§3.3).
      this.#header = { ...header, schemaVersion: SCHEMA_VERSION };
      for (let i = 0; i < header.bucketCount; i++) this.#dirtyBuckets.add(i);
      this.#headerDirty = true;
    } else {
      this.#header = header;
    }
  }

  /**
   * Forget every secret.
   *
   * Pending writes are flushed first by default, because losing the last thing a user typed to a
   * lock timer is a bug, not a security feature. Panic-lock (Phase 4) passes `flush: false`: there,
   * being immediate is the whole point.
   */
  async lock(options: { readonly flush?: boolean } = {}): Promise<void> {
    if (options.flush !== false && !this.locked) {
      try {
        await this.flush();
      } catch (error) {
        this.#deferredError = error;
      }
    }
    this.#cancelTimer();
    this.#dek?.dispose();
    this.#dek = null;
    this.#itemsKey = null;
    this.#hmacKey = null;
    this.#header = null;
    this.#items = new Map();
    this.#bucketByItem = new Map();
    this.#dirtyBuckets.clear();
    this.#headerDirty = false;
    this.#index = null;
  }

  /** Lock, then remove every trace of the vault from this profile. Irreversible, by design. */
  async destroy(): Promise<void> {
    await this.lock({ flush: false });
    this.#deferredError = null;
    await clearVault();
  }

  /* ---------------------------------------------------------------- reads */

  /** Every item, tombstones excluded. Synchronous: the vault is already decrypted in memory. */
  getAll(options: GetAllOptions = {}): VaultItem[] {
    this.#assertUnlocked('reading items');
    const all = [...this.#items.values()];
    return options.includeDeleted === true ? all : all.filter((item) => !isDeleted(item));
  }

  getItem(id: string): VaultItem | undefined {
    this.#assertUnlocked('reading an item');
    return this.#items.get(id);
  }

  /** The item map, for the pure functions in `vault/model.ts`. */
  items(): ItemMap {
    this.#assertUnlocked('reading items');
    return this.#items;
  }

  /** Search the unlocked vault. The index is built on first use and dropped on any change. */
  search(query: string, options?: SearchOptions): SearchHit[] {
    this.#assertUnlocked('searching');
    this.#index ??= buildSearchIndex(this.#items.values());
    return search(this.#index, query, options);
  }

  /* ---------------------------------------------------------------- writes */

  /**
   * Apply a batch of mutations as one revision.
   *
   * The whole batch commits at a single `vaultRev`, so a multi-item operation (a bulk move, an
   * import) is one revision to merge rather than a hundred. Returns the items that actually
   * changed — an edit that changes nothing returns an empty array and costs nothing.
   */
  async apply(mutations: readonly Mutation[]): Promise<readonly VaultItem[]> {
    this.#throwDeferred();
    this.#assertUnlocked('applying mutations');
    const header = this.#header;
    if (header === null) throw new VaultLockedError('applying mutations');

    const now = this.#now();
    const rev = header.vaultRev + 1;
    const result = applyMutations(this.#items, mutations, { now, rev, newId: this.#newId });
    if (result.changed.length === 0) return [];

    this.#items = result.items;
    for (const item of result.changed) {
      const index =
        this.#bucketByItem.get(item.id) ?? (await bucketOf(item.id, header.bucketCount));
      this.#bucketByItem.set(item.id, index);
      this.#dirtyBuckets.add(index);
    }

    this.#header = { ...header, vaultRev: rev, updatedAt: now };
    this.#headerDirty = true;
    this.#index = null;
    this.#scheduleFlush();
    return result.changed;
  }

  /**
   * Drop tombstones past the 90-day TTL (D20).
   *
   * Not automatic on unlock: purging is a write, and a read-only unlock should not rewrite the
   * vault. The service worker calls this from a housekeeping alarm (Phase 4).
   */
  async purge(ttlMs: number = TOMBSTONE_TTL_MS): Promise<readonly string[]> {
    this.#throwDeferred();
    this.#assertUnlocked('purging tombstones');
    const header = this.#header;
    if (header === null) throw new VaultLockedError('purging tombstones');

    const { items, purged } = purgeTombstones(this.#items, this.#now(), ttlMs);
    if (purged.length === 0) return [];

    this.#items = items;
    for (const id of purged) {
      const index = this.#bucketByItem.get(id);
      if (index !== undefined) this.#dirtyBuckets.add(index);
      this.#bucketByItem.delete(id);
    }
    this.#header = { ...header, vaultRev: header.vaultRev + 1, updatedAt: this.#now() };
    this.#headerDirty = true;
    this.#index = null;
    // Written immediately rather than coalesced: a purge runs from a housekeeping alarm, and an
    // MV3 service worker that is torn down 300 ms later would lose it silently.
    await this.flush();
    return purged;
  }

  /**
   * Re-wrap the DEK under a key derived from a new password.
   *
   * Thirty-two bytes are re-encrypted and nothing else moves: no bucket is touched, no ciphertext
   * changes, no sync storm, and no window in which the vault is half-converted. That is the entire
   * reason for the two-level key hierarchy (ARCHITECTURE §4.1). `vaultRev` still advances, because
   * peers need a reason to pull the new header.
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    this.#throwDeferred();
    this.#assertUnlocked('changing the password');
    const header = this.#header;
    const dek = this.#dek;
    if (header === null || dek === null) throw new VaultLockedError('changing the password');
    assertPasswordLength(newPassword);

    // Verify the current password against the stored wrap rather than against anything in memory:
    // an unlocked session must not be a way to change the password without knowing it.
    const currentKek = await deriveKek(currentPassword, fromBase64Url(header.kdf.salt), {
      alg: header.kdf.alg,
      iterations: header.kdf.iterations,
    });
    await unwrapDek(currentKek, header.wrappedDek);

    const salt = generateKdfSalt();
    const kek = await deriveKek(newPassword, salt, RECOMMENDED_KDF_PARAMS);
    const wrappedDek = await wrapDek(kek, dek.value);

    this.#header = {
      ...header,
      kdf: { ...RECOMMENDED_KDF_PARAMS, salt: toBase64Url(salt) },
      wrappedDek,
      vaultRev: header.vaultRev + 1,
      updatedAt: this.#now(),
    };
    this.#headerDirty = true;
    await this.flush();
  }

  /**
   * Write everything pending, now.
   *
   * Buckets first, header last (§"Things that are easy to get wrong"): a crash between the two must
   * leave a header pointing at the *old* revision, not at half-written buckets.
   */
  async flush(): Promise<void> {
    this.#cancelTimer();
    this.#flushing = (this.#flushing ?? Promise.resolve()).then(
      () => this.#writePending(),
      () => this.#writePending(),
    );
    const flushing = this.#flushing;
    try {
      await flushing;
    } finally {
      if (this.#flushing === flushing) this.#flushing = null;
    }
    this.#throwDeferred();
  }

  /** Bucket indices with unwritten changes. Exposed for tests and for the sync scheduler. */
  dirtyBuckets(): ReadonlySet<number> {
    return this.#dirtyBuckets;
  }

  /* ---------------------------------------------------------------- internals */

  async #writePending(): Promise<void> {
    const header = this.#header;
    const itemsKey = this.#itemsKey;
    const hmacKey = this.#hmacKey;
    if (header === null || itemsKey === null || hmacKey === null) return;
    if (this.#dirtyBuckets.size === 0 && !this.#headerDirty) return;

    const dirty = [...this.#dirtyBuckets].sort((a, b) => a - b);
    this.#dirtyBuckets.clear();
    this.#headerDirty = false;
    try {
      await this.#writeBucketsAndHeader(header, dirty, itemsKey, hmacKey);
    } catch (error) {
      // A failed write must stay pending: the items are still in memory and correct, and the next
      // flush has to try again rather than leave `storage.local` a revision behind for good.
      for (const index of dirty) this.#dirtyBuckets.add(index);
      this.#headerDirty = true;
      throw error;
    }
  }

  async #writeBucketsAndHeader(
    header: VaultHeader,
    dirty: readonly number[],
    itemsKey: CryptoKey,
    hmacKey: CryptoKey,
  ): Promise<void> {
    const payloads = new Map<number, BucketPayload>();
    for (const index of dirty) payloads.set(index, { items: [] });
    const grouped = new Map<number, VaultItem[]>();
    for (const item of this.#items.values()) {
      const index = this.#bucketByItem.get(item.id);
      if (index === undefined || !payloads.has(index)) continue;
      const bucket = grouped.get(index) ?? [];
      bucket.push(item);
      grouped.set(index, bucket);
    }
    for (const [index, items] of grouped) {
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      payloads.set(index, { items });
    }

    const sealed = new Map<number, Bytes | null>();
    const metas = new Map<number, BucketMeta>();
    for (const [index, payload] of payloads) {
      if (payload.items.length === 0) {
        sealed.set(index, null);
        metas.set(index, {
          i: index,
          rev: header.vaultRev,
          parts: 0,
          tag: await bucketTag(hmacKey, payload),
        });
        continue;
      }
      const { sealed: bytes, tag } = await sealBucket(itemsKey, hmacKey, index, payload);
      sealed.set(index, bytes);
      metas.set(index, { i: index, rev: header.vaultRev, parts: partsFor(bytes.length), tag });
    }

    if (sealed.size > 0) await writeBuckets(sealed);

    const buckets = header.buckets.map((meta) => metas.get(meta.i) ?? meta);
    const next: VaultHeader = { ...header, buckets };
    this.#header = next;
    await writeHeader(next);
  }

  async #adoptKeys(dek: Bytes): Promise<void> {
    this.#dek?.dispose();
    this.#dek = new Secret(dek);
    this.#itemsKey = await subkey(dek, 'items');
    this.#hmacKey = await subkey(dek, 'hmac');
  }

  #scheduleFlush(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush().catch((error: unknown) => {
        this.#deferredError = error;
      });
    }, this.#coalesceMs);
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #throwDeferred(): void {
    const error = this.#deferredError;
    if (error === null) return;
    this.#deferredError = null;
    // Rethrown verbatim: this is a value caught from a write that failed on the coalescing timer,
    // and re-wrapping it would bury the storage error the caller actually needs to see.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw error;
  }

  #assertUnlocked(operation: string): void {
    if (this.locked) throw new VaultLockedError(operation);
  }

  #requireItemsKey(): CryptoKey {
    if (this.#itemsKey === null) throw new VaultLockedError('sealing bucket contents');
    return this.#itemsKey;
  }

  #requireHmacKey(): CryptoKey {
    if (this.#hmacKey === null) throw new VaultLockedError('computing a bucket tag');
    return this.#hmacKey;
  }
}

/**
 * The one hard password rule (ARCHITECTURE §4.6). Everything softer than this — the strength
 * meter, the "are you sure" for a weak-but-legal password — is the UI's job.
 *
 * Counted in code points, so ten emoji are ten characters, exactly as `estimateStrength` counts.
 */
function assertPasswordLength(password: string): void {
  if (passwordLength(password) < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(MIN_PASSWORD_LENGTH);
  }
}

/** A bucket table for a vault with nothing in it: every bucket present, none of them stored. */
function emptyBucketTable(bucketCount: number, rev: number, tag: string): BucketMeta[] {
  return Array.from({ length: bucketCount }, (_unused, i) => ({ i, rev, parts: 0, tag }));
}
