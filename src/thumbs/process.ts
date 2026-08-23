/**
 * Decode, downscale, re-encode (ARCHITECTURE §14.3).
 *
 * What comes out is at most 320 px on its longest edge and at most 40 KB, and it is a **new image**
 * rather than the page's one shrunk: everything goes through a canvas, so the output carries no
 * EXIF, no GPS, no maker notes and no colour profile beyond what the encoder writes. Stripping
 * metadata is not a step here — it is a consequence of the pipeline, which is the only kind of
 * stripping that cannot be forgotten. A holiday photo somebody used as an `og:image` does not bring
 * its coordinates into the vault.
 *
 * **The platform calls are behind {@link ImageOps}.** Not for indirection's sake: `createImageBitmap`
 * and `OffscreenCanvas` do not exist in Node, so the loop below — never upscale, step the quality
 * down, give up rather than store something enormous — would otherwise be code that only ever runs
 * in a browser and is only ever tested by an end-to-end test. The seam lets the policy be tested
 * exhaustively and the real pipeline be tested for real in Playwright.
 */

import type { Bytes } from '../crypto/codec.js';
import { ThumbRejected, validateDimensions } from './validate.js';

/** Longest edge of a stored thumbnail. A row preview at 2× and a card at 1× both fit inside it. */
export const THUMB_MAX_EDGE = 320;

/** The one retry: if 320 px will not fit the byte cap at any quality, try again at this edge. */
export const THUMB_FALLBACK_EDGE = 256;

/** Byte cap on a stored thumbnail. 8 MB of local cache (§14.6) is then ~200 pictures. */
export const THUMB_MAX_BYTES = 40 * 1024;

/** Quality ladder, walked until the result fits (§14.3). */
export const QUALITY_STEPS: readonly number[] = [0.75, 0.6, 0.45, 0.3];

/** What we ask for, and what we settle for where WebP encoding is unavailable. */
export const PREFERRED_TYPE = 'image/webp';
export const FALLBACK_TYPE = 'image/jpeg';

/* --------------------------------------------------------------- icons (§10.1) */

/**
 * Longest edge of a stored page-sourced icon. The size a row asks `_favicon/` for, so the two
 * sources produce the same picture at the same size (`background/favicons.ts`, `ICON_SIZE`).
 */
export const ICON_MAX_EDGE = 32;

/**
 * Byte cap on a stored icon: the one `_favicon/` responses are already held to
 * (`thumbs/favicons.ts`, `MAX_ICON_BYTES`), so the store has one limit and not two.
 *
 * It is never the binding constraint, and that is measured rather than hoped: across the 20 real
 * sites of 2026-08-22 every stored icon re-encoded to **between 740 and 1,558 bytes** (§10.1). The
 * quality ladder below is therefore a guard against something strange, not a routine path — in
 * practice the first encode is the only one.
 */
export const ICON_MAX_BYTES = 64 * 1024;

/** Quality ladder for an icon. Short, because the first step has never yet failed to fit. */
export const ICON_QUALITY_STEPS: readonly number[] = [0.9, 0.7, 0.5];

/**
 * What we settle for when WebP is unavailable **for an icon**, and it is not {@link FALLBACK_TYPE}.
 *
 * JPEG has no alpha channel. Favicons overwhelmingly do have one, and a transparent icon flattened
 * into a JPEG becomes a 32-pixel black square on every row of that host — a worse outcome than the
 * lettered avatar it replaced. PNG is larger and, at 32 px against a 64 KB cap, that costs nothing.
 */
export const ICON_FALLBACK_TYPE = 'image/png';

/** A decoded image that can be re-encoded at a size. Closed by {@link processThumb} when it is done. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /**
   * Draw at `width` × `height` and encode.
   *
   * Answers with the type it actually produced, which is how the WebP fallback is decided: a canvas
   * whose encoder does not know WebP is allowed to hand back a PNG instead of failing, so the only
   * reliable question is "what did I get?" rather than "what do you support?".
   */
  encode(
    width: number,
    height: number,
    type: string,
    quality: number,
  ): Promise<{ readonly bytes: Bytes; readonly type: string }>;
  close(): void;
}

export interface ImageOps {
  decode(bytes: Bytes, contentType: string): Promise<DecodedImage>;
}

export interface Thumbnail {
  readonly bytes: Bytes;
  readonly width: number;
  readonly height: number;
  readonly type: string;
}

/**
 * Fit a size inside a square of `edge`, preserving the aspect ratio and **never upscaling**.
 *
 * A 100 × 80 avatar stays 100 × 80. Blowing it up to 320 would cost bytes to make it blurrier, and
 * the row it is rendered in scales it down again anyway.
 */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const scale = edge / longest;
  // At least one pixel on each axis: a 10,000 × 1 strip would otherwise round to a zero-height
  // canvas, which throws rather than producing anything. The aspect check refuses it first, but
  // this function is exported and should not depend on its caller having done that.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The whole of §14.3, in one call.
 *
 * Throws {@link ThumbRejected} for an image that will not decode, is a decompression bomb, or will
 * not fit the byte cap at any quality on either edge. "No thumbnail" is a perfectly good outcome and
 * the caller treats it as one.
 */
export async function processThumb(
  bytes: Bytes,
  contentType: string,
  ops: ImageOps = platformImageOps(),
): Promise<Thumbnail> {
  let image: DecodedImage;
  try {
    image = await ops.decode(bytes, contentType);
  } catch (cause) {
    throw new ThumbRejected('undecodable', { cause });
  }

  try {
    validateDimensions(image.width, image.height);
    return await encodeWithin(image, {
      edges: [THUMB_MAX_EDGE, THUMB_FALLBACK_EDGE],
      qualities: QUALITY_STEPS,
      maxBytes: THUMB_MAX_BYTES,
      fallbackType: FALLBACK_TYPE,
    });
  } finally {
    image.close();
  }
}

/**
 * §14.3 again, at 32 px, for a **page-declared favicon** (§10.1, D37).
 *
 * Same shape as {@link processThumb} and deliberately the same code underneath, because the reason
 * for the pipeline is the same and the strongest of them survives the change of subject: these
 * bytes came off a page, and re-encoding through a canvas is what makes the stored icon a bitmap
 * this browser drew rather than a file a site chose to serve. Nothing arrives in the vault that
 * `createImageBitmap` did not first agree was an image.
 *
 * Three things differ from a thumbnail, and each is the icon's own:
 *
 * - **One edge, not two.** There is nothing sensible below 32 px to retry at, and nothing needs it:
 *   the byte cap has never been reached (see {@link ICON_MAX_BYTES}).
 * - **PNG, not JPEG, where WebP is unavailable** — {@link ICON_FALLBACK_TYPE}, for the alpha channel.
 * - **A PNG result ends the ladder immediately.** PNG encoders ignore `quality`, so walking three
 *   steps would be three byte-identical encodes of the same bitmap.
 *
 * Throws {@link ThumbRejected} exactly as `processThumb` does, and the caller treats "no icon" as
 * the ordinary outcome it is.
 */
export async function processIcon(
  bytes: Bytes,
  contentType: string,
  ops: ImageOps = platformImageOps(),
): Promise<Thumbnail> {
  let image: DecodedImage;
  try {
    image = await ops.decode(bytes, contentType);
  } catch (cause) {
    throw new ThumbRejected('undecodable', { cause });
  }

  try {
    validateDimensions(image.width, image.height);
    return await encodeWithin(image, {
      edges: [ICON_MAX_EDGE],
      qualities: ICON_QUALITY_STEPS,
      maxBytes: ICON_MAX_BYTES,
      fallbackType: ICON_FALLBACK_TYPE,
    });
  } finally {
    image.close();
  }
}

/**
 * Draw and encode until something fits, or give up.
 *
 * Shared by both pipelines so that "never upscale", the WebP probe and the give-up condition have
 * one implementation rather than two that drift.
 *
 * **The encoder is probed once and the answer reused.** Asking a canvas for WebP four times to be
 * told four times that it will hand back PNG is three wasted encodes of a full-size bitmap; the
 * only reliable question is "what did I get?", because a canvas whose encoder does not know WebP is
 * allowed to answer with something else rather than to fail.
 */
async function encodeWithin(
  image: DecodedImage,
  options: {
    readonly edges: readonly number[];
    readonly qualities: readonly number[];
    readonly maxBytes: number;
    readonly fallbackType: string;
  },
): Promise<Thumbnail> {
  let type = PREFERRED_TYPE;
  let probed = false;

  for (const edge of options.edges) {
    const size = fitWithin(image.width, image.height, edge);
    for (const quality of options.qualities) {
      let result = await image.encode(size.width, size.height, type, quality);
      if (!probed) {
        probed = true;
        if (result.type !== PREFERRED_TYPE) {
          type = options.fallbackType;
          result = await image.encode(size.width, size.height, type, quality);
        }
      }
      if (result.bytes.length <= options.maxBytes) {
        return { bytes: result.bytes, width: size.width, height: size.height, type: result.type };
      }
      // A PNG of a given bitmap is the same PNG at every quality. Trying the rest of the ladder
      // would be byte-identical work; the next edge, if there is one, is the only thing left.
      if (result.type === 'image/png') break;
    }
  }
  throw new ThumbRejected('unencodable');
}

/**
 * The real thing: `createImageBitmap` → `OffscreenCanvas` → `convertToBlob`.
 *
 * Built lazily, per call, rather than held at module scope — this file is in the service worker's
 * import graph and MV3 evaluates it on every cold start, where touching `OffscreenCanvas` at the top
 * level would be work done for the many wakes that never capture anything.
 */
export function platformImageOps(): ImageOps {
  return {
    async decode(bytes: Bytes, contentType: string): Promise<DecodedImage> {
      // `from-image` so a JPEG that carries an orientation tag is drawn upright. The tag itself does
      // not survive the canvas, so an unrotated draw would store a sideways picture for good.
      const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType }), {
        imageOrientation: 'from-image',
      });
      return {
        width: bitmap.width,
        height: bitmap.height,
        async encode(width, height, type, quality) {
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext('2d');
          if (context === null) throw new ThumbRejected('undecodable');
          context.drawImage(bitmap, 0, 0, width, height);
          const blob = await canvas.convertToBlob({ type, quality });
          return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
        },
        close: () => {
          bitmap.close();
        },
      };
    },
  };
}
