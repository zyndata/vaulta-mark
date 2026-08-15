import { extractNotes, versionOf, ReleaseNotesError } from '../../../scripts/release-notes.mjs';

const CHANGELOG = `# Changelog

Prose about the format, which is not part of any release.

## [Unreleased]

### Added

- Something not yet shipped.

## [1.1.0] - 2026-09-01

### Added

- A second thing.

### Fixed

- A thing that was broken.

## [1.0.0] - 2026-08-14

### Added

- The first release.

<!-- an editorial note to whoever edits this file next -->

[Unreleased]: https://github.com/zyndata/vaulta-mark/compare/v1.1.0...dev
[1.1.0]: https://github.com/zyndata/vaulta-mark/releases/tag/v1.1.0
`;

describe('versionOf', () => {
  it('accepts a tag with or without its v', () => {
    expect(versionOf('v1.2.3')).toBe('1.2.3');
    expect(versionOf('1.2.3')).toBe('1.2.3');
    expect(versionOf('  v1.2.0-rc.1 ')).toBe('1.2.0-rc.1');
  });

  it('refuses "Unreleased", which is the mistake it exists to catch', () => {
    // A release published under the heading of the next one is only noticed afterwards.
    expect(() => versionOf('Unreleased')).toThrow(ReleaseNotesError);
    expect(() => versionOf('unreleased')).toThrow(/RELEASE §4 step 3/);
  });

  it('refuses an empty or non-SemVer argument', () => {
    expect(() => versionOf('')).toThrow(/No tag given/);
    expect(() => versionOf('release-1')).toThrow(/not a SemVer version/);
    expect(() => versionOf('v1.2')).toThrow(/not a SemVer version/);
  });
});

describe('extractNotes', () => {
  it('returns one section, its date, and nothing from its neighbours', () => {
    const notes = extractNotes(CHANGELOG, 'v1.1.0');
    expect(notes.version).toBe('1.1.0');
    expect(notes.date).toBe('2026-09-01');
    expect(notes.body).toContain('A second thing.');
    expect(notes.body).toContain('### Fixed');
    expect(notes.body).not.toContain('not yet shipped');
    expect(notes.body).not.toContain('The first release.');
  });

  it('reads the last section without swallowing the link-reference block', () => {
    const notes = extractNotes(CHANGELOG, 'v1.0.0');
    expect(notes.body.trim()).toBe('### Added\n\n- The first release.');
  });

  it('drops HTML comments, which address the file rather than the reader', () => {
    expect(extractNotes(CHANGELOG, 'v1.0.0').body).not.toContain('editorial note');
  });

  it('names the sections it does have when the one asked for is missing', () => {
    expect(() => extractNotes(CHANGELOG, 'v2.0.0')).toThrow(/Unreleased, 1.1.0, 1.0.0/);
  });

  it('finds a section with no date on it', () => {
    expect(extractNotes('## [1.0.0]\n\n- Shipped.\n', 'v1.0.0')).toMatchObject({
      date: null,
      body: '- Shipped.\n',
    });
  });

  it('reports an empty changelog rather than an empty section', () => {
    expect(() => extractNotes('# Changelog\n', 'v1.0.0')).toThrow(/\(no sections\)/);
  });

  it('returns an empty body for a section that was tagged but never written', () => {
    // main() turns this into a failure; the extractor's job is only to report it faithfully.
    expect(extractNotes('## [1.0.0] - 2026-08-14\n\n## [0.9.0]\n', 'v1.0.0').body).toBe('\n');
  });
});
