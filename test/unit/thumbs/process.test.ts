/**
 * The downscale-and-encode policy (ARCHITECTURE §14.3).
 *
 * `createImageBitmap` and `OffscreenCanvas` do not exist in Node, so the platform half is behind
 * {@link ImageOps} and this file drives a stand-in that reports what it was *asked* for. That is the
 * right seam for these questions: "never upscale", "walk the quality ladder", "give up rather than
 * store something enormous" and "fall back to JPEG" are all statements about the loop, not about
 * libwebp. The real pipeline — a real 4000 × 3000 photograph, a real EXIF-tagged JPEG — is exercised
 * in Chromium by `test/e2e/thumbs.spec.ts`, where those APIs exist.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_TYPE,
  ICON_FALLBACK_TYPE,
  ICON_MAX_BYTES,
  ICON_MAX_EDGE,
  ICON_QUALITY_STEPS,
  PREFERRED_TYPE,
  QUALITY_STEPS,
  THUMB_FALLBACK_EDGE,
  THUMB_MAX_BYTES,
  THUMB_MAX_EDGE,
  fitWithin,
  processIcon,
  processThumb,
  type DecodedImage,
  type ImageOps,
} from '../../../src/thumbs/process.js';
import { ThumbRejected, type RejectReason } from '../../../src/thumbs/validate.js';

interface EncodeCall {
  readonly width: number;
  readonly height: number;
  readonly type: string;
  readonly quality: number;
}

/**
 * A decoder that never fails and an encoder whose output size is a function of what it was asked
 * for: area × quality × `scale`. That is enough to make the step-down ladder observable — a large
 * `scale` forces it all the way down, a small one lets the first attempt win.
 */
function fakeOps(options: {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** What the canvas actually produces, whatever it was asked for. Defaults to what it was asked. */
  readonly produces?: string;
  readonly calls?: EncodeCall[];
  readonly closed?: { value: boolean };
}): ImageOps {
  return {
    decode(): Promise<DecodedImage> {
      return Promise.resolve({
        width: options.width,
        height: options.height,
        encode(width, height, type, quality) {
          options.calls?.push({ width, height, type, quality });
          const size = Math.round(width * height * quality * options.scale);
          return Promise.resolve({
            bytes: new Uint8Array(size),
            type: options.produces ?? type,
          });
        },
        close: () => {
          if (options.closed !== undefined) options.closed.value = true;
        },
      });
    },
  };
}

const SOME_BYTES = new Uint8Array([1, 2, 3]);

/** The reason a rejected capture gave, or `null` when it was not rejected. */
async function reasonOf(run: () => Promise<unknown>): Promise<RejectReason | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof ThumbRejected) return error.reason;
    throw error;
  }
}

describe('fitWithin', () => {
  it('scales the longest edge down to the box and keeps the aspect ratio', () => {
    expect(fitWithin(4000, 3000, 320)).toEqual({ width: 320, height: 240 });
    expect(fitWithin(3000, 4000, 320)).toEqual({ width: 240, height: 320 });
  });

  it('never upscales', () => {
    expect(fitWithin(100, 80, 320)).toEqual({ width: 100, height: 80 });
    expect(fitWithin(320, 200, 320)).toEqual({ width: 320, height: 200 });
  });

  it('keeps at least one pixel on each axis', () => {
    expect(fitWithin(10_000, 1, 320)).toEqual({ width: 320, height: 1 });
  });
});

describe('processThumb', () => {
  it('downscales a 4000 × 3000 photograph to 320 px on its longest edge', async () => {
    const result = await processThumb(SOME_BYTES, 'image/jpeg', fakeOps({
      width: 4000,
      height: 3000,
      scale: 1 / 40_000,
    }));

    expect(Math.max(result.width, result.height)).toBe(THUMB_MAX_EDGE);
    expect(result.width / result.height).toBeCloseTo(4 / 3, 2);
    expect(result.bytes.length).toBeLessThanOrEqual(THUMB_MAX_BYTES);
    expect(result.type).toBe(PREFERRED_TYPE);
  });

  it('does not upscale a 100 × 80 source', async () => {
    const calls: EncodeCall[] = [];
    const result = await processThumb(SOME_BYTES, 'image/png', fakeOps({
      width: 100,
      height: 80,
      scale: 1 / 1000,
      calls,
    }));

    expect(result).toMatchObject({ width: 100, height: 80 });
    expect(calls[0]).toMatchObject({ width: 100, height: 80 });
  });

  it('walks the quality ladder in order until the result fits', async () => {
    const calls: EncodeCall[] = [];
    // Sized so 0.75 and 0.6 are both over the cap at 320 px and 0.45 is under it.
    const scale = THUMB_MAX_BYTES / (320 * 240 * 0.5);
    const result = await processThumb(SOME_BYTES, 'image/jpeg', fakeOps({
      width: 1600,
      height: 1200,
      scale,
      calls,
    }));

    expect(calls.map((call) => call.quality)).toEqual([0.75, 0.6, 0.45]);
    expect(result.bytes.length).toBeLessThanOrEqual(THUMB_MAX_BYTES);
    expect(result.width).toBe(THUMB_MAX_EDGE);
  });

  it('drops to the smaller edge once the ladder runs out, then gives up', async () => {
    const calls: EncodeCall[] = [];
    const reason = await reasonOf(() =>
      processThumb(SOME_BYTES, 'image/jpeg', fakeOps({
        width: 1600,
        height: 1200,
        // Nothing fits, at any quality, at either edge: the cheapest attempt the loop can make is
        // 256 × 192 at 0.3, and this puts even that over the cap.
        scale: 5,
        calls,
      })),
    );

    expect(reason).toBe('unencodable');
    // The loop terminates: one pass per edge, one attempt per quality step, and no more.
    expect(calls).toHaveLength(QUALITY_STEPS.length * 2);
    expect(calls.slice(0, QUALITY_STEPS.length).every((call) => call.width === THUMB_MAX_EDGE)).toBe(true);
    expect(
      calls.slice(QUALITY_STEPS.length).every((call) => call.width === THUMB_FALLBACK_EDGE),
    ).toBe(true);
  });

  it('falls back to JPEG when the canvas will not produce WebP, and asks only once', async () => {
    const calls: EncodeCall[] = [];
    const result = await processThumb(SOME_BYTES, 'image/png', fakeOps({
      width: 800,
      height: 600,
      scale: 1 / 40_000,
      produces: 'image/png',
      calls,
    }));

    // WebP asked for once, refused once, and never asked for again.
    expect(calls.map((call) => call.type)).toEqual([PREFERRED_TYPE, FALLBACK_TYPE]);
    expect(result.type).toBe('image/png');
  });

  it('refuses a decompression bomb before it encodes anything', async () => {
    const calls: EncodeCall[] = [];
    const reason = await reasonOf(() =>
      processThumb(SOME_BYTES, 'image/png', fakeOps({
        width: 20_000,
        height: 20_000,
        scale: 1,
        calls,
      })),
    );

    expect(reason).toBe('dimensions');
    expect(calls).toHaveLength(0);
  });

  it('reports an undecodable image rather than letting the decoder error escape', async () => {
    const reason = await reasonOf(() =>
      processThumb(SOME_BYTES, 'image/png', {
        decode: () => Promise.reject(new Error('not an image')),
      }),
    );
    expect(reason).toBe('undecodable');
  });

  it('closes the bitmap on the way out, success or failure', async () => {
    const closed = { value: false };
    await processThumb(SOME_BYTES, 'image/png', fakeOps({
      width: 400,
      height: 300,
      scale: 1 / 40_000,
      closed,
    }));
    expect(closed.value).toBe(true);

    const failed = { value: false };
    await reasonOf(() =>
      processThumb(SOME_BYTES, 'image/png', fakeOps({
        width: 400,
        height: 300,
        scale: 5,
        closed: failed,
      })),
    );
    expect(failed.value).toBe(true);
  });

  it('uses the platform pipeline by default', async () => {
    // Not a behavioural test of `createImageBitmap` — there is none here — but the default argument
    // is the line that decides whether the product ever calls it, and a typo in it would only ever
    // show up in a browser.
    const decode = vi.fn().mockRejectedValue(new Error('no canvas in Node'));
    expect(await reasonOf(() => processThumb(SOME_BYTES, 'image/png', { decode }))).toBe(
      'undecodable',
    );
    expect(decode).toHaveBeenCalledWith(SOME_BYTES, 'image/png');
  });
});

/* ------------------------------------------------------------------ icons (§10.1, D37) */

describe('processIcon', () => {
  it('fits a big icon inside 32 px, preserving the aspect ratio', async () => {
    const calls: EncodeCall[] = [];
    const icon = await processIcon(SOME_BYTES, 'image/x-icon', fakeOps({
      width: 256,
      height: 256,
      scale: 0.0001,
      calls,
    }));

    expect(icon.width).toBe(ICON_MAX_EDGE);
    expect(icon.height).toBe(ICON_MAX_EDGE);
    expect(calls[0]).toMatchObject({ width: 32, height: 32 });
  });

  it('never upscales a 16 px favicon into a blurred 32', async () => {
    // A great many sites still serve 16 × 16. Blowing it up costs bytes to make it worse, and the
    // row scales it back down anyway.
    const icon = await processIcon(SOME_BYTES, 'image/png', fakeOps({
      width: 16,
      height: 16,
      scale: 0.0001,
    }));
    expect(icon).toMatchObject({ width: 16, height: 16 });
  });

  it('keeps the odd aspect ratio real favicons come in', async () => {
    // Measured on 2026-08-22: web.dev serves a 33 × 32. It is one pixel over the edge, so it is
    // fitted rather than kept — but it is fitted, not squared. A 32 × 32 here would mean the
    // pipeline had stretched a real icon to make the arithmetic tidier.
    const icon = await processIcon(SOME_BYTES, 'image/png', fakeOps({
      width: 33,
      height: 32,
      scale: 0.0001,
    }));
    expect(icon).toMatchObject({ width: 32, height: 31 });
  });

  it('takes the first quality step, which is all the measurements ever needed', async () => {
    const calls: EncodeCall[] = [];
    await processIcon(SOME_BYTES, 'image/x-icon', fakeOps({
      width: 48,
      height: 48,
      scale: 0.0001,
      calls,
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: PREFERRED_TYPE, quality: ICON_QUALITY_STEPS[0] });
  });

  it('walks the ladder when the first step will not fit', async () => {
    const calls: EncodeCall[] = [];
    // Sized so that only the last quality step comes in under the cap.
    const scale = (ICON_MAX_BYTES * 1.2) / (32 * 32 * ICON_QUALITY_STEPS[0]!);
    await processIcon(SOME_BYTES, 'image/png', fakeOps({ width: 64, height: 64, scale, calls }));

    expect(calls.map((call) => call.quality)).toEqual([...ICON_QUALITY_STEPS].slice(0, calls.length));
    expect(calls.length).toBeGreaterThan(1);
  });

  it('falls back to PNG, not JPEG — a favicon has an alpha channel', async () => {
    // JPEG cannot carry transparency, and a flattened favicon is a black square on every row of
    // that host: worse than the lettered avatar it replaced.
    const calls: EncodeCall[] = [];
    const icon = await processIcon(SOME_BYTES, 'image/x-icon', fakeOps({
      width: 32,
      height: 32,
      scale: 0.0001,
      produces: ICON_FALLBACK_TYPE,
      calls,
    }));

    expect(icon.type).toBe(ICON_FALLBACK_TYPE);
    expect(ICON_FALLBACK_TYPE).not.toBe(FALLBACK_TYPE);
    expect(calls.map((call) => call.type)).toEqual([PREFERRED_TYPE, ICON_FALLBACK_TYPE]);
  });

  it('stops the ladder as soon as PNG is the answer', async () => {
    // PNG encoders ignore `quality`, so the rest of the ladder would be byte-identical work.
    const calls: EncodeCall[] = [];
    await reasonOf(() =>
      processIcon(SOME_BYTES, 'image/png', fakeOps({
        width: 32,
        height: 32,
        scale: ICON_MAX_BYTES,
        produces: ICON_FALLBACK_TYPE,
        calls,
      })),
    );

    // The WebP probe, the PNG it actually produced, and then nothing more.
    expect(calls).toHaveLength(2);
  });

  it('refuses an icon that will not decode', async () => {
    const ops: ImageOps = { decode: () => Promise.reject(new Error('not an image')) };
    expect(await reasonOf(() => processIcon(SOME_BYTES, 'image/x-icon', ops))).toBe('undecodable');
  });

  it('refuses a decompression bomb dressed as a favicon', async () => {
    const ops = fakeOps({ width: 20_000, height: 20_000, scale: 0.0001 });
    expect(await reasonOf(() => processIcon(SOME_BYTES, 'image/png', ops))).toBe('dimensions');
  });

  it('refuses a zero-sized decode', async () => {
    const ops = fakeOps({ width: 0, height: 0, scale: 1 });
    expect(await reasonOf(() => processIcon(SOME_BYTES, 'image/png', ops))).toBe('undecodable');
  });

  it('gives up rather than store something enormous', async () => {
    const ops = fakeOps({ width: 32, height: 32, scale: ICON_MAX_BYTES });
    expect(await reasonOf(() => processIcon(SOME_BYTES, 'image/png', ops))).toBe('unencodable');
  });

  it('closes the bitmap even when it gives up', async () => {
    const closed = { value: false };
    await reasonOf(() =>
      processIcon(SOME_BYTES, 'image/png', fakeOps({
        width: 32,
        height: 32,
        scale: ICON_MAX_BYTES,
        closed,
      })),
    );
    expect(closed.value).toBe(true);
  });
});
