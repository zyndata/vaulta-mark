/**
 * The error taxonomy for the crypto layer.
 *
 * Callers act on these very differently — a wrong password is a normal, expected user event that
 * deserves "try again"; a corrupt vault is a data-loss situation that deserves a restore-from-backup
 * path — so they must never collapse into a bare `Error`. That distinction is also a security
 * property: it is the only place where the two are allowed to be told apart, and only because the
 * caller already knows which operation it asked for.
 *
 * Every message here is a *developer* string. Nothing in this file is shown to a user; the UI maps
 * the error class to a localized message (Phase 12).
 */

/** Base class for everything this layer throws, so a caller can catch the whole family. */
export class CryptoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The DEK could not be unwrapped with the key derived from the supplied password.
 *
 * There is no password verifier in the vault (D12), so this *is* the password check: AES-GCM's tag
 * fails, and a failed tag on that one operation means the password was wrong. It is thrown only
 * from `unwrapDek`, and only for a tag failure — malformed header bytes raise `CorruptVaultError`
 * instead, because a truncated header says nothing about the password.
 */
export class WrongPasswordError extends CryptoError {
  constructor(message = 'The master password is incorrect.', options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Authenticated data did not authenticate, or a container was structurally invalid.
 *
 * Covers a failed GCM tag on any envelope, a bad envelope version byte, a truncated blob, and
 * padding that does not decode. All of these mean the bytes are not what we wrote, whether through
 * corruption, truncation, or tampering — we do not distinguish, because the response is the same.
 */
export class CorruptVaultError extends CryptoError {
  constructor(
    message = 'The vault data is damaged or has been tampered with.',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The vault declares a schema version this build does not know how to read.
 *
 * Always a *newer* vault: older ones are migrated (Phase 3). Writing a downgraded vault would
 * silently destroy whatever the newer version added, so the only safe response is to refuse.
 */
export class UnsupportedSchemaError extends CryptoError {
  constructor(
    readonly schemaVersion: number,
    readonly supportedVersion: number,
    options?: ErrorOptions,
  ) {
    super(
      `Vault schema version ${schemaVersion} is newer than the supported version ${supportedVersion}.`,
      options,
    );
  }
}
