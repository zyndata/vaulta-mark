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

    // Decided once, on the first encode, and reused: asking the canvas for WebP four times to be
    // told four times that it will give us PNG is three wasted encodes of a full-size bitmap.
    let type = PREFERRED_TYPE;
    let probed = false;

    for (const edge of [THUMB_MAX_EDGE, THUMB_FALLBACK_EDGE]) {
      const size = fitWithin(image.width, image.height, edge);
      for (const quality of QUALITY_STEPS) {
        let result = await image.encode(size.width, size.height, type, quality);
        if (!probed) {
          probed = true;
          if (result.type !== PREFERRED_TYPE) {
            type = FALLBACK_TYPE;
            result = await image.encode(size.width, size.height, type, quality);
          }
        }
        if (result.bytes.length <= THUMB_MAX_BYTES) {
          return { bytes: result.bytes, width: size.width, height: size.height, type: result.type };
        }
      }
    }
    throw new ThumbRejected('unencodable');
  } finally {
    image.close();
  }
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
