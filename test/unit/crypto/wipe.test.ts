import { describe, expect, it, vi } from 'vitest';

import { DisposedSecretError, Secret, zero, zeroAll } from '../../../src/crypto/wipe.js';
import { randomBytes } from '../../helpers/bytes.js';

describe('zero', () => {
  it('overwrites in place, so every alias of the buffer sees the erasure', () => {
    const bytes = randomBytes(32);
    const alias = bytes.subarray(8, 16);
    zero(bytes);
    expect([...bytes].every((byte) => byte === 0)).toBe(true);
    expect([...alias].every((byte) => byte === 0)).toBe(true);
  });

  it('only touches the view it is given', () => {
    const backing = new Uint8Array(16).fill(0xff);
    zero(backing.subarray(4, 8));
    expect([...backing]).toStrictEqual([
      0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });
});

describe('zeroAll', () => {
  it('erases every buffer and skips the absent ones', () => {
    const first = randomBytes(8);
    const second = randomBytes(8);
    zeroAll(first, null, undefined, second);
    expect([...first, ...second].every((byte) => byte === 0)).toBe(true);
  });
});

describe('Secret', () => {
  it('zeroes byte payloads on dispose', () => {
    const bytes = randomBytes(32);
    const secret = new Secret(bytes);
    expect(secret.value).toBe(bytes);
    secret.dispose();
    expect([...bytes].every((byte) => byte === 0)).toBe(true);
  });

  it('refuses to hand back a disposed value', () => {
    const secret = new Secret(randomBytes(8));
    secret.dispose();
    expect(secret.disposed).toBe(true);
    expect(() => secret.value).toThrow(DisposedSecretError);
  });

  it('is idempotent, because MV3 races a lock alarm against a user click routinely', () => {
    const onDispose = vi.fn();
    const secret = new Secret(randomBytes(8), onDispose);
    secret.dispose();
    secret.dispose();
    secret.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('runs a custom disposer for values that are not bytes', () => {
    const key = { name: 'not-a-CryptoKey' };
    const onDispose = vi.fn();
    const secret = new Secret(key, onDispose);
    secret.dispose();
    expect(onDispose).toHaveBeenCalledWith(key);
  });

  it('does nothing but forget, for a value it cannot reach into', () => {
    // A CryptoKey's material is opaque to us. The default disposer must not pretend otherwise —
    // it drops the reference and that is all, which is exactly what wipe.ts documents.
    const opaque = { handle: 1 };
    const secret = new Secret(opaque);
    secret.dispose();
    expect(opaque).toStrictEqual({ handle: 1 });
    expect(secret.disposed).toBe(true);
  });
});
