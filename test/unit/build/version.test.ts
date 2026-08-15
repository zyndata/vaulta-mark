import { InvalidVersionError, toChromeVersion } from '../../../build/version';

describe('toChromeVersion', () => {
  it('passes a plain release through unchanged', () => {
    expect(toChromeVersion('1.2.3')).toBe('1.2.3');
    expect(toChromeVersion('0.1.0')).toBe('0.1.0');
  });

  it('folds a pre-release into a fourth component', () => {
    expect(toChromeVersion('1.2.0-rc.1')).toBe('1.2.0.1');
    expect(toChromeVersion('1.2.0-beta.4')).toBe('1.2.0.4');
    expect(toChromeVersion('2.0.0-alpha.12')).toBe('2.0.0.12');
  });

  it('drops build metadata, which Chrome has nowhere to put', () => {
    expect(toChromeVersion('1.2.3+abc1234')).toBe('1.2.3');
  });

  it('rejects anything Chrome would reject', () => {
    expect(() => toChromeVersion('1.2')).toThrow(InvalidVersionError);
    expect(() => toChromeVersion('v1.2.3')).toThrow(InvalidVersionError);
    expect(() => toChromeVersion('1.2.3-nightly')).toThrow(InvalidVersionError);
    expect(() => toChromeVersion('70000.0.0')).toThrow(InvalidVersionError);
  });
});
