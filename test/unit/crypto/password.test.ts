import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fromBase64Url, gunzip, utf8Decode } from '../../../src/crypto/codec.js';
import {
  COMMON_PASSWORD_COUNT,
  COMMON_PASSWORDS_GZ,
} from '../../../src/crypto/data/common-passwords.js';
import {
  ACCEPTABLE_SCORE,
  estimateStrength,
  isCommonPassword,
  MIN_PASSWORD_LENGTH,
  type PasswordWarning,
} from '../../../src/crypto/password.js';
import { buildList, renderTxt } from '../../../scripts/gen-common-passwords.mjs';

const TXT_PATH = 'src/crypto/data/common-passwords.txt';

async function warningsFor(password: string): Promise<readonly PasswordWarning[]> {
  return (await estimateStrength(password)).warnings;
}

describe('the bundled common-password list', () => {
  it('has not drifted from its generator', () => {
    // The `.txt` is what a human audits; the generator is what produces it. If someone edits one
    // without the other, the shipped list stops meaning what the repo says it means.
    expect(readFileSync(TXT_PATH, 'utf8')).toBe(renderTxt(buildList()));
  });

  it('decompresses back to exactly the committed plaintext', async () => {
    const decompressed = utf8Decode(await gunzip(fromBase64Url(COMMON_PASSWORDS_GZ)));
    expect(decompressed).toBe(readFileSync(TXT_PATH, 'utf8'));
    expect(decompressed.trimEnd().split('\n').length).toBe(COMMON_PASSWORD_COUNT);
  });

  it('is around the ~2,000 entries the spec calls for', () => {
    expect(COMMON_PASSWORD_COUNT).toBeGreaterThan(1500);
    expect(COMMON_PASSWORD_COUNT).toBeLessThan(5000);
  });

  it('ships compressed, at a fraction of the plaintext size', () => {
    expect(COMMON_PASSWORDS_GZ.length).toBeLessThan(readFileSync(TXT_PATH, 'utf8').length / 2);
  });

  it('is sorted, deduplicated and lowercase', () => {
    const list = buildList();
    expect(list).toStrictEqual([...list].sort());
    expect(new Set(list).size).toBe(list.length);
    expect(list.every((entry) => entry === entry.toLowerCase())).toBe(true);
  });

  it('contains the passwords that top every breach corpus', async () => {
    for (const password of ['password', '123456', 'qwerty', 'letmein', 'iloveyou', 'admin1']) {
      expect(await isCommonPassword(password)).toBe(true);
    }
  });

  it('is matched case-insensitively', async () => {
    expect(await isCommonPassword('PASSWORD')).toBe(true);
    expect(await isCommonPassword('Monkey123')).toBe(true);
  });

  it('does not contain a passphrase nobody has ever leaked', async () => {
    expect(await isCommonPassword('marmalade-tractor-plinth-9')).toBe(false);
  });
});

describe('the hard length floor', () => {
  it('is 10 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });

  it('fails anything shorter, however exotic', async () => {
    const strength = await estimateStrength('xK9#mQ2$w');
    expect(strength.meetsMinimumLength).toBe(false);
    expect(strength.acceptable).toBe(false);
    expect(strength.warnings).toContain('too-short');
    // A short password cannot score above 1 no matter how much entropy the character classes claim.
    expect(strength.score).toBeLessThanOrEqual(1);
  });

  it('counts code points, not UTF-16 units', async () => {
    // Ten emoji are ten characters. Counting `.length` would call them twenty and wave them through.
    expect((await estimateStrength('🔐'.repeat(5))).meetsMinimumLength).toBe(false);
    expect((await estimateStrength('🔐'.repeat(10))).meetsMinimumLength).toBe(true);
  });

  it('handles the empty password without throwing', async () => {
    const strength = await estimateStrength('');
    expect(strength.score).toBe(0);
    expect(strength.bits).toBe(0);
    expect(strength.warnings).toStrictEqual(['too-short']);
  });
});

describe('estimateStrength', () => {
  it('gives a real passphrase a passing score', async () => {
    for (const password of [
      'correct-horse-battery-staple',
      'Th3 gr33n tractor sings badly',
      'xK9#mQ2$wL7@vB4!nR',
    ]) {
      const strength = await estimateStrength(password);
      expect(strength.score).toBeGreaterThanOrEqual(ACCEPTABLE_SCORE);
      expect(strength.acceptable).toBe(true);
    }
  });

  it('bottoms out a password that is on the list', async () => {
    const strength = await estimateStrength('football2024');
    expect(strength.warnings).toContain('common-password');
    expect(strength.score).toBe(0);
    expect(strength.acceptable).toBe(false);
  });

  it('sees through leet substitutions', async () => {
    // `P@ssw0rd` is not on the list; `password` is, and that is the same password.
    const strength = await estimateStrength('P@ssw0rd!!');
    expect(strength.warnings).toContain('common-password-variant');
    expect(strength.acceptable).toBe(false);
  });

  it('sees through appended digits and punctuation', async () => {
    expect(await warningsFor('sunshine!!!!')).toContain('common-password-variant');
    expect(await warningsFor('monkey987654')).toContain('common-password-variant');
  });

  it('flags a keyboard walk', async () => {
    expect(await warningsFor('qwertyuiop[]')).toContain('keyboard-pattern');
    expect(await warningsFor('zaq12wsxcde3')).toContain('keyboard-pattern');
    expect(await warningsFor('poiuytrewqas')).toContain('keyboard-pattern');
  });

  it('flags a character sequence in either direction', async () => {
    expect(await warningsFor('abcdefghijkl')).toContain('sequential-characters');
    expect(await warningsFor('zyxwvutsrqpo')).toContain('sequential-characters');
    expect(await warningsFor('my9876543210')).toContain('sequential-characters');
  });

  it('flags a run of the same character, and does not credit it as entropy', async () => {
    const repeated = await estimateStrength('Qaaaaaaaaaaaaaaaaaaa9');
    const varied = await estimateStrength('Qwmzptbnkvcxlrhjgudf9');
    expect(repeated.warnings).toContain('repeated-characters');
    expect(repeated.bits).toBeLessThan(varied.bits);
  });

  it('flags a year, which is where half of all passwords end', async () => {
    expect(await warningsFor('tractorplinth2024')).toContain('year-like');
    expect(await warningsFor('tractorplinth1987')).toContain('year-like');
    expect(await warningsFor('tractorplinth2500')).not.toContain('year-like');
  });

  it('flags a single character class', async () => {
    expect(await warningsFor('tractorplinth')).toContain('single-character-class');
    expect(await warningsFor('TractorPlinth')).not.toContain('single-character-class');
  });

  it('rewards length and class variety, monotonically', async () => {
    const scores = await Promise.all(
      ['jmvbtkwq', 'jmvbtkwqrz', 'jmvbtkwqrzHD', 'jmvbtkwqrzHD47', 'jmvbtkwqrzHD47%$'].map(
        async (password) => (await estimateStrength(password)).bits,
      ),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i] ?? 0).toBeGreaterThan(scores[i - 1] ?? 0);
    }
  });

  it('returns warnings sorted and deduplicated, so the UI can render them stably', async () => {
    const warnings = await warningsFor('aaaa1234qwer');
    expect(warnings).toStrictEqual([...warnings].sort());
    expect(new Set(warnings).size).toBe(warnings.length);
  });

  it('rounds the entropy estimate to something a meter can show', async () => {
    const { bits } = await estimateStrength('jmvbtkwqrzHD47%$');
    expect(bits).toBe(Math.round(bits * 10) / 10);
  });

  it('memoizes the list, so a strength meter can run on every keystroke', async () => {
    const started = performance.now();
    for (const prefix of 'a-master-password-typed-out'.split('')) {
      await estimateStrength(prefix.repeat(12));
    }
    // The first call decompresses ~7 KB; every later one must not. A per-call decompression would
    // put this well past a second.
    expect(performance.now() - started).toBeLessThan(500);
  });
});
