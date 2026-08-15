/**
 * SemVer → Chrome extension version mapping.
 *
 * Chrome accepts 1–4 dot-separated integers in [0, 65535] and nothing else, so a SemVer
 * pre-release identifier has to be folded into a fourth component. See
 * docs/ARCHITECTURE.md §2 "Version mapping" — pre-releases are never uploaded to the Store,
 * only attached to GitHub Releases, which is what makes this mapping safe despite Chrome
 * sorting `1.2.0.1` *below* `1.2.0`.
 */

const SEMVER =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const MAX_COMPONENT = 65535;

export class InvalidVersionError extends Error {
  constructor(version: string, reason: string) {
    super(`Cannot map "${version}" to a Chrome extension version: ${reason}`);
    this.name = 'InvalidVersionError';
  }
}

/**
 * `1.2.3` → `1.2.3`, `1.2.0-rc.1` → `1.2.0.1`, `1.2.0-beta.4` → `1.2.0.4`.
 * Build metadata (`+sha`) is dropped; Chrome has nowhere to put it.
 */
export function toChromeVersion(version: string): string {
  const match = SEMVER.exec(version.trim());
  if (!match?.groups) {
    throw new InvalidVersionError(version, 'not a valid SemVer string');
  }

  const { major, minor, patch, prerelease } = match.groups as {
    major: string;
    minor: string;
    patch: string;
    prerelease?: string;
  };

  const components = [major, minor, patch];

  if (prerelease !== undefined) {
    const numeric = /(\d+)$/.exec(prerelease);
    if (!numeric) {
      throw new InvalidVersionError(
        version,
        `pre-release "${prerelease}" has no trailing number to map to a fourth component`,
      );
    }
    components.push(String(Number(numeric[1])));
  }

  for (const component of components) {
    if (Number(component) > MAX_COMPONENT) {
      throw new InvalidVersionError(version, `component "${component}" exceeds ${MAX_COMPONENT}`);
    }
  }

  return components.join('.');
}
