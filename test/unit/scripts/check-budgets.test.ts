/**
 * The shipped-size budgets (PLAN §9 Phase 12).
 *
 * Two halves. `checkBudgets` is fed synthetic measurements, including the ones on either side of
 * each ceiling — a budget whose boundary is untested is a budget that might be off by one in the
 * forgiving direction. `measure` is then run once against the **real** `dist/`, which is the
 * assertion that the package currently fits; a check that only ever sees fixtures proves nothing
 * about what ships.
 */

import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BUDGETS,
  checkBudgets,
  checkCodeSplitting,
  entryScripts,
  measure,
  report,
} from '../../../scripts/check-budgets.mjs';

interface Measurement {
  zipBytes: number;
  files: { name: string; bytes: number; zipped: number }[];
}

const DIST = fileURLToPath(new URL('../../../dist', import.meta.url));

const file = (name: string, bytes: number) => ({ name, bytes, zipped: Math.round(bytes / 3) });

const fits: Measurement = {
  zipBytes: 150 * 1024,
  files: [
    file('background.js', 180 * 1024),
    file('assets/manager-abc.js', 80 * 1024),
    file('manifest.json', 2 * 1024),
  ],
};

describe('the ceilings', () => {
  it('passes a package that fits', () => {
    expect(checkBudgets(fits)).toEqual([]);
  });

  it('fails a package that is too big to download', () => {
    const problems = checkBudgets({ ...fits, zipBytes: BUDGETS.zipBytes + 1 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('over the 400.0 KB budget');
  });

  it('holds a document chunk to 150 KB', () => {
    // What a page parses before it paints — the thing the original budget was about.
    const over = { ...fits, files: [file('assets/manager-abc.js', BUDGETS.chunkBytes + 1)] };
    expect(checkBudgets(over)[0]).toContain('single-chunk budget');
  });

  it('holds the service worker to its own, larger ceiling', () => {
    /*
     * Two numbers rather than one, and this is the pair of cases that says why. `background.js` at
     * 180 KB is fine and any other file at 180 KB is not: the worker cannot be split (a service
     * worker that code-splits will `import()` after being torn down), so it is the one file whose
     * size is not a statement about what a document parses before it paints. See PLAN §9 Phase 12.
     */
    expect(checkBudgets({ ...fits, files: [file('background.js', 180 * 1024)] })).toEqual([]);
    expect(checkBudgets({ ...fits, files: [file('other.js', 180 * 1024)] })).not.toEqual([]);

    const over = { ...fits, files: [file('background.js', BUDGETS.workerBytes + 1)] };
    expect(checkBudgets(over)[0]).toContain('service-worker budget');
  });

  it('measures exactly at the ceiling as passing, and one byte over as failing', () => {
    expect(checkBudgets({ ...fits, zipBytes: BUDGETS.zipBytes })).toEqual([]);
    expect(checkBudgets({ ...fits, zipBytes: BUDGETS.zipBytes + 1 })).not.toEqual([]);
  });

  it('ignores what is not JavaScript, however big', () => {
    // `_locales/en/messages.json` is 100 KB and is not parsed as code by anything.
    const big = { ...fits, files: [file('_locales/en/messages.json', 500 * 1024)] };
    expect(checkBudgets(big)).toEqual([]);
  });
});

describe('the report', () => {
  it('lists every file, largest first, with both sizes', () => {
    const text = report(fits, '1.2.3');
    expect(text).toContain('# Bundle report — 1.2.3');
    expect(text.indexOf('background.js')).toBeLessThan(text.indexOf('manager-abc.js'));
    expect(text).toContain('manifest.json');
    // Both ceilings are named, so the artifact says what it was measured against.
    expect(text).toContain('Largest document chunk');
    expect(text).toContain('Service worker');
  });
});

/**
 * PLAN §9 Phase 15. The encoder is found by a string it throws, so these fixtures carry that string
 * rather than a filename — the same reason the check itself does.
 */
describe('the QR encoder stays out of the eager chunks', () => {
  const entry = (name: string, text: string) => ({ name, data: Buffer.from(text, 'utf8') });
  const MARKER = 'code length overflow';

  const manifest = entry('manifest.json', JSON.stringify({ background: { service_worker: 'background.js' } }));
  const document_ = entry(
    'manager.html',
    '<script type="module" crossorigin src="/assets/manager-abc.js"></script>',
  );

  it('reads the eager scripts out of the document and the manifest', () => {
    expect([...entryScripts([manifest, document_])].sort()).toEqual([
      'assets/manager-abc.js',
      'background.js',
    ]);
  });

  it('passes a build where only the lazy chunk carries it', () => {
    const entries = [
      manifest,
      document_,
      entry('assets/manager-abc.js', 'await import(`./qrcode-def.js`);'),
      entry('assets/qrcode-def.js', `throw ${JSON.stringify(MARKER)};`),
      entry('background.js', 'const worker = true;'),
    ];
    expect(checkCodeSplitting(entries)).toEqual([]);
  });

  it("fails a build that folded it into the manager's first paint", () => {
    const entries = [
      manifest,
      document_,
      entry('assets/manager-abc.js', `throw ${JSON.stringify(MARKER)};`),
      entry('background.js', 'const worker = true;'),
    ];
    expect(checkCodeSplitting(entries)[0]).toContain('assets/manager-abc.js is loaded eagerly');
  });

  it('fails a build that put it in the service worker', () => {
    const entries = [
      manifest,
      document_,
      entry('assets/manager-abc.js', 'const page = true;'),
      entry('background.js', `throw ${JSON.stringify(MARKER)};`),
    ];
    expect(checkCodeSplitting(entries)[0]).toContain('background.js is loaded eagerly');
  });

  it('fails a build carrying two copies of it', () => {
    const entries = [
      manifest,
      document_,
      entry('assets/manager-abc.js', 'const page = true;'),
      entry('assets/qrcode-def.js', `throw ${JSON.stringify(MARKER)};`),
      entry('assets/qrcode-ghi.js', `throw ${JSON.stringify(MARKER)};`),
      entry('background.js', 'const worker = true;'),
    ];
    expect(checkCodeSplitting(entries)[0]).toContain('in 2 chunks');
  });

  /*
   * The marker is a string literal inside somebody else's source. Re-vendoring could take it away
   * and every assertion above would keep passing against a package with no encoder in it at all.
   */
  it('fails a build where nothing carries it', () => {
    expect(checkCodeSplitting([manifest, document_])[0]).toContain('no chunk carries the QR encoder');
  });
});

describe('the package as it stands', () => {
  it('fits every budget', async () => {
    // Skipped rather than failed when there is no build: `npm run test` runs before `npm run
    // build` in `npm run verify`, so a clean checkout reaches this file with no dist/ at all.
    // The gate is the `check-budgets` step in the same pipeline, which runs after the build.
    const built = await access(DIST).then(
      () => true,
      () => false,
    );
    if (!built) return;

    const measurement = await measure();
    expect(checkBudgets(measurement)).toEqual([]);
    expect(checkCodeSplitting(measurement.entries)).toEqual([]);
    // A sanity check on the measurement itself: an empty dist/ would satisfy every budget.
    expect(measurement.files.some((entry) => entry.name === 'background.js')).toBe(true);
    expect(measurement.zipBytes).toBeGreaterThan(10_000);
  });
});
