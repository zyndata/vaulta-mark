/**
 * Best-effort erasure of key material.
 *
 * **This is not a guarantee, and the code must not be read as one.** JavaScript gives us no way to
 * prove a value is gone: strings are immutable and the garbage collector is free to have copied
 * them, `CryptoKey` internals are opaque to us, and an engine may keep a buffer alive in a
 * register, a nursery, or a heap snapshot long after the last reference drops. What we *can* do is
 * (a) keep raw key bytes in a `Uint8Array` rather than a `string` wherever we control the shape,
 * (b) overwrite those arrays on lock, and (c) never write key material to `storage.local` or
 * `storage.sync`. That reduces the window; it does not close it. SECURITY.md says the same thing
 * to users, in the same terms — see ARCHITECTURE §4.5.
 */

/** Overwrite a buffer with zeroes in place. */
export function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** Overwrite several buffers, skipping any that are absent. */
export function zeroAll(...buffers: readonly (Uint8Array | null | undefined)[]): void {
  for (const buffer of buffers) {
    if (buffer) zero(buffer);
  }
}

/** Raised when a disposed {@link Secret} is read. Always a bug in the caller, never user-visible. */
export class DisposedSecretError extends Error {
  constructor() {
    super('This secret has been disposed and can no longer be read.');
    this.name = 'DisposedSecretError';
  }
}

/**
 * A value whose lifetime is explicit.
 *
 * The point is not that `dispose()` makes the bytes unrecoverable — see the caveat above — but that
 * *forgetting* to release a secret becomes visible in the code rather than invisible. A `Secret`
 * that is still readable after `lock()` is a bug you can see in a diff; a stray `Uint8Array` in a
 * module-scope variable is not. INV-7 is asserted against this shape.
 *
 * `dispose()` is idempotent, so a lock path that runs twice (an alarm racing a user click, which
 * MV3 makes routine) does not throw.
 */
export class Secret<T> {
  #value: T | null;
  #disposed = false;
  readonly #onDispose: (value: T) => void;

  constructor(value: T, onDispose: (value: T) => void = disposeDefault) {
    this.#value = value;
    this.#onDispose = onDispose;
  }

  /** The wrapped value. Throws once disposed rather than silently handing back stale bytes. */
  get value(): T {
    if (this.#disposed || this.#value === null) throw new DisposedSecretError();
    return this.#value;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const value = this.#value;
    this.#value = null;
    if (value !== null) this.#onDispose(value);
  }
}

/** Zeroes byte arrays; a no-op for anything else (a `CryptoKey` has nothing we can reach into). */
function disposeDefault(value: unknown): void {
  if (value instanceof Uint8Array) zero(value);
}
