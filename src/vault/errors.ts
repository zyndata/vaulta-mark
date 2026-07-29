/**
 * The error taxonomy for the vault layer.
 *
 * Same rule as `src/crypto/errors.ts`: nothing crosses a module boundary as a bare `Error`, because
 * the caller's response differs completely between "you asked for an item that is not there" (a
 * bug, or a stale UI) and "these bytes are not a vault" (a restore-from-backup situation).
 *
 * Schema-version failures deliberately reuse `UnsupportedSchemaError` from the crypto taxonomy
 * rather than growing a second one: it is the error a caller already catches around unlock, and
 * splitting it would make every call site handle two names for one condition.
 *
 * Every message here is a *developer* string. User-facing text lives in `_locales` (Phase 12).
 */

/** Base class for everything this layer throws, so a caller can catch the whole family. */
export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A mutation named an item that is not in the vault. */
export class ItemNotFoundError extends VaultError {
  constructor(
    readonly itemId: string,
    options?: ErrorOptions,
  ) {
    super(`No vault item with id ${itemId}.`, options);
  }
}

/**
 * A mutation that the vault refuses to perform: an unknown parent, a folder moved inside itself,
 * a bookmark used as a parent, a duplicate id.
 *
 * These are caller bugs rather than user errors, and they are rejected before anything is written
 * — a half-applied mutation batch would leave the item tree inconsistent behind an intact GCM tag,
 * which is the worst kind of corruption because nothing detects it.
 */
export class InvalidMutationError extends VaultError {}

/** An operation that needs the DEK ran while the vault was locked. Always a caller bug. */
export class VaultLockedError extends VaultError {
  constructor(operation: string, options?: ErrorOptions) {
    super(`The vault is locked; ${operation} requires an unlocked vault.`, options);
  }
}

/** `create()` on a device that already has a vault, or `unlock()` on one that has none. */
export class VaultStateError extends VaultError {}
