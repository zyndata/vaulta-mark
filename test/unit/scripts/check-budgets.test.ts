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

import { BUDGETS, checkBudgets, measure, report } from '../../../scripts/check-budgets.mjs';

interface Measurement {
  zipBytes: number;
  files: { name: string; bytes: number; zipped: number }[];
}

const DIST = fileURLToPath(new URL('../../../dist', import.meta.url));

const file = (name: string, bytes: number) => ({ name, bytes, zipped: Math.round(bytes / 3) });

const fits: Measurement = {
  zipBytes: 150 * 1024,
  files: [
    file('background.js', 300 * 1024),
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
     * 300 KB is fine and any other file at 300 KB is not: the worker cannot be split (a service
     * worker that code-splits will `import()` after being torn down) and 153 KB of it is two
     * bundled data sets whose evaluation cost is measured separately. See PLAN §9 Phase 12.
     */
    expect(checkBudgets({ ...fits, files: [file('background.js', 300 * 1024)] })).toEqual([]);
    expect(checkBudgets({ ...fits, files: [file('other.js', 300 * 1024)] })).not.toEqual([]);

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
    // A sanity check on the measurement itself: an empty dist/ would satisfy every budget.
    expect(measurement.files.some((entry) => entry.name === 'background.js')).toBe(true);
    expect(measurement.zipBytes).toBeGreaterThan(10_000);
  });
});
