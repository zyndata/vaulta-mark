import { checkVersions } from '../../../scripts/check-version-sync.mjs';

const agreeing = {
  tag: 'v1.2.3',
  packageVersion: '1.2.3',
  manifestVersion: '1.2.3',
};

describe('checkVersions', () => {
  it('passes when all three agree', () => {
    expect(checkVersions(agreeing)).toEqual([]);
    expect(checkVersions({ ...agreeing, tag: '1.2.3' })).toEqual([]);
  });

  it('catches a tag pushed before the version bump was committed', () => {
    const problems = checkVersions({ ...agreeing, packageVersion: '1.2.2', manifestVersion: '1.2.2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/tag says 1.2.3 and package.json says 1.2.2/);
  });

  it('catches a stale dist/, which is the failure the Store notices and GitHub does not', () => {
    const problems = checkVersions({ ...agreeing, manifestVersion: '1.2.2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/rebuild it/);
  });

  it('compares the manifest through the Chrome mapping, not by string equality', () => {
    // `1.2.0-rc.1` legitimately builds as `1.2.0.1` (ARCHITECTURE §2). A direct string compare
    // would report every pre-release as broken.
    expect(
      checkVersions({ tag: 'v1.2.0-rc.1', packageVersion: '1.2.0-rc.1', manifestVersion: '1.2.0.1' }),
    ).toEqual([]);
    expect(
      checkVersions({ tag: 'v1.2.0-rc.1', packageVersion: '1.2.0-rc.1', manifestVersion: '1.2.0' }),
    ).toHaveLength(1);
  });

  it('reports a pre-release Chrome cannot express, instead of crashing on it', () => {
    const problems = checkVersions({
      tag: 'v1.2.0-beta',
      packageVersion: '1.2.0-beta',
      manifestVersion: '1.2.0',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no trailing number/);
  });

  it('skips the manifest leg when dist/ is not built, unless --built says otherwise', () => {
    expect(checkVersions({ ...agreeing, manifestVersion: null })).toEqual([]);
    expect(
      checkVersions({ ...agreeing, manifestVersion: null, requireManifest: true }),
    ).toEqual(['dist/manifest.json is missing — run `npm run build` before checking it.']);
  });

  it('refuses a tag that is not a version, and says nothing else until it is fixed', () => {
    // Reporting "the tag disagrees with package.json" about `latest` would send someone to bump a
    // version that is already correct.
    expect(checkVersions({ ...agreeing, tag: 'latest' })).toEqual([
      'The tag "latest" is not a SemVer version — releases are tagged `v1.2.3`.',
    ]);
    expect(checkVersions({ ...agreeing, tag: '' })).toEqual([
      'No tag given. Usage: check-version-sync.mjs v1.2.3',
    ]);
  });

  it('refuses a package.json version that is not a version', () => {
    expect(checkVersions({ ...agreeing, packageVersion: 'next' })).toEqual([
      'package.json version "next" is not a SemVer version.',
    ]);
  });
});
