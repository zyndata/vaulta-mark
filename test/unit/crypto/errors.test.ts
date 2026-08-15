import { describe, expect, it } from 'vitest';

import {
  CorruptVaultError,
  CryptoError,
  UnsupportedSchemaError,
  WrongPasswordError,
} from '../../../src/crypto/errors.js';

describe('crypto error taxonomy', () => {
  it('lets a caller catch the whole family', () => {
    for (const error of [
      new WrongPasswordError(),
      new CorruptVaultError(),
      new UnsupportedSchemaError(3, 2),
    ]) {
      expect(error).toBeInstanceOf(CryptoError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it('keeps the two vault-failure modes distinguishable', () => {
    // The whole point of the taxonomy: "try again" and "restore from backup" are very different
    // instructions to give a user, and a bare Error cannot tell them apart.
    expect(new WrongPasswordError()).not.toBeInstanceOf(CorruptVaultError);
    expect(new CorruptVaultError()).not.toBeInstanceOf(WrongPasswordError);
  });

  it('names itself after its own class, so a stack trace is readable', () => {
    expect(new WrongPasswordError().name).toBe('WrongPasswordError');
    expect(new CorruptVaultError().name).toBe('CorruptVaultError');
    expect(new UnsupportedSchemaError(3, 2).name).toBe('UnsupportedSchemaError');
  });

  it('carries the schema versions that made a vault unreadable', () => {
    const error = new UnsupportedSchemaError(7, 2);
    expect(error.schemaVersion).toBe(7);
    expect(error.supportedVersion).toBe(2);
    expect(error.message).toContain('7');
    expect(error.message).toContain('2');
  });

  it('preserves the underlying cause when one is given', () => {
    const cause = new Error('OperationError');
    expect(new CorruptVaultError('damaged', { cause }).cause).toBe(cause);
    expect(new WrongPasswordError(undefined, { cause }).cause).toBe(cause);
  });

  it('accepts a caller-supplied message without losing its identity', () => {
    const error = new CorruptVaultError('bucket 3 failed its tag check');
    expect(error.message).toBe('bucket 3 failed its tag check');
    expect(error).toBeInstanceOf(CorruptVaultError);
    expect(error.name).toBe('CorruptVaultError');
  });
});
