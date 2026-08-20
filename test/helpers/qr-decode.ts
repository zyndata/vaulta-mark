/**
 * A QR decoder, written for the tests and owing nothing to the encoder they exercise.
 *
 * `src/ui/qr.ts` has one failure mode that matters and it is silent: a symbol that scans to
 * something other than the address it was asked for. Nothing in the extension can notice — the code
 * is drawn, it looks like a QR code, and it is wrong on somebody's phone. So the test for it has to
 * *read the symbol back*, and reading it back with the same library that wrote it would only prove
 * the library agrees with itself.
 *
 * This walks the symbol the way ISO/IEC 18004 says a reader does: version from the module count,
 * format information from the symbol's own corner (so the mask and the error-correction level are
 * read, never assumed), the function-pattern map, the two-module-wide zigzag, the mask undone, and
 * the segments parsed. It is anchored at the other end by `test/unit/ui/qr.test.ts`, which decodes
 * the standard's own worked example and compares the codewords with the ones the standard prints.
 *
 * **It does not do error correction and it does not de-interleave.** Neither is needed: the symbol
 * comes straight out of an encoder rather than off a camera, so no codeword is damaged, and a
 * single-block symbol stores its data codewords in order at the front. Versions 1 to 5 at level L
 * are one block, which is where the tests stay — up to 106 bytes of byte-mode payload. A symbol
 * bigger than that would be read as interleaved nonsense and the round trip would fail loudly,
 * which is the right way for this limit to make itself known.
 */

import type { QrMatrix } from '../../src/ui/qr.js';

export interface DecodedQr {
  /** 1 to 40. */
  readonly version: number;
  readonly errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
  /** 0 to 7. */
  readonly maskPattern: number;
  /** Every codeword in reading order — data first, then error correction. */
  readonly codewords: readonly number[];
  /** The decoded segments, concatenated. */
  readonly text: string;
}

/**
 * Alignment-pattern centre coordinates, versions 1 to 10 (ISO/IEC 18004 table E.1).
 *
 * Only as far as the tests reach. A version beyond this throws rather than guessing, because a
 * decoder that silently treats an alignment pattern as data produces a plausible wrong answer.
 */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [], // v1
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50], // v10
];

/** ISO/IEC 18004 §8.8.1. `i` is the row, `j` the column. */
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** Indicator bits 14–13 of the format information, in their numeric order. */
const EC_LEVELS = ['M', 'L', 'H', 'Q'] as const;

export function decodeQr(matrix: QrMatrix): DecodedQr {
  const size = matrix.size;
  if ((size - 17) % 4 !== 0) throw new Error(`${String(size)} modules is not a QR symbol size`);
  const version = (size - 17) / 4;
  if (version < 1 || version > ALIGNMENT_CENTRES.length) {
    throw new Error(`version ${String(version)} is outside what this decoder covers`);
  }

  const format = readFormat(matrix);
  const codewords = readCodewords(matrix, version, format.maskPattern);
  return {
    version,
    errorCorrectionLevel: format.errorCorrectionLevel,
    maskPattern: format.maskPattern,
    codewords,
    text: parseSegments(codewords, version),
  };
}

/**
 * The 15 format bits from the copy beside the top-left finder, unmasked with 0x5412.
 *
 * The redundant copy along the other two edges is not read: it exists so a reader can recover from
 * damage, and there is no damage here. Reading one copy and trusting it is the stricter test — a
 * bug that wrote the two copies differently would still be caught, by the symbol not scanning.
 */
function readFormat(matrix: QrMatrix): {
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
  maskPattern: number;
} {
  let bits = 0;
  for (let index = 14; index >= 0; index -= 1) {
    const [row, column] = formatPosition(index);
    bits = (bits << 1) | (matrix.isDark(row, column) ? 1 : 0);
  }
  const value = bits ^ 0x5412;
  const level = EC_LEVELS[(value >> 13) & 0b11];
  if (level === undefined) throw new Error('unreachable: two bits index four levels');
  return { errorCorrectionLevel: level, maskPattern: (value >> 10) & 0b111 };
}

/**
 * Where format bit `index` (0 = least significant) lives, ISO/IEC 18004 §8.9.
 *
 * The least significant bits run *down* column 8 and the most significant run *left* along row 8,
 * turning the corner at (8, 8). Writing it the other way round — the mirror image — is the mistake
 * this function was born with, and it survived the standard's own worked example: reading a
 * fifteen-bit field backwards still lands on a plausible level and mask often enough to look right
 * once. It was the level-L round trips that caught it, by reporting M.
 */
function formatPosition(index: number): [number, number] {
  if (index <= 5) return [index, 8];
  if (index === 6) return [7, 8];
  if (index === 7) return [8, 8];
  if (index === 8) return [8, 7];
  return [8, 14 - index];
}

/**
 * Every codeword, in the order the standard places them, with the mask undone.
 *
 * The walk is two modules wide, upward then downward, right to left, skipping the vertical timing
 * column — and skipping every module the function patterns claimed, which is what `reserved` below
 * is for. Getting either wrong shifts the whole bitstream and produces a decode that fails on the
 * very first mode indicator, which is the behaviour a test wants.
 */
function readCodewords(matrix: QrMatrix, version: number, maskPattern: number): number[] {
  const size = matrix.size;
  const reserved = functionPatterns(version, size);
  const mask = MASKS[maskPattern];
  if (mask === undefined) throw new Error(`mask pattern ${String(maskPattern)} does not exist`);

  const codewords: number[] = [];
  let current = 0;
  let filled = 0;
  let row = size - 1;
  let upward = true;

  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column -= 1; // the vertical timing pattern is never a data column
    for (;;) {
      for (const at of [column, column - 1]) {
        if (reserved[row]?.[at] === true) continue;
        const dark = matrix.isDark(row, at) !== mask(row, at);
        current = (current << 1) | (dark ? 1 : 0);
        filled += 1;
        if (filled === 8) {
          codewords.push(current);
          current = 0;
          filled = 0;
        }
      }
      row += upward ? -1 : 1;
      if (row < 0 || row >= size) {
        row -= upward ? -1 : 1;
        upward = !upward;
        break;
      }
    }
  }

  return codewords;
}

/** `true` for every module a function pattern or a reservation owns. */
function functionPatterns(version: number, size: number): boolean[][] {
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const claim = (fromRow: number, fromColumn: number, rows: number, columns: number): void => {
    for (let row = fromRow; row < fromRow + rows; row += 1) {
      for (let column = fromColumn; column < fromColumn + columns; column += 1) {
        if (row < 0 || column < 0 || row >= size || column >= size) continue;
        reserved[row]![column] = true;
      }
    }
  };

  // Finders, their separators, and the format-information strips beside them. Taken as three
  // rectangles rather than pattern by pattern: everything inside them is reserved either way, and
  // the dark module at (size - 8, 8) falls inside the bottom-left one without a special case.
  claim(0, 0, 9, 9);
  claim(0, size - 8, 9, 8);
  claim(size - 8, 0, 8, 9);

  // Timing patterns.
  claim(6, 0, 1, size);
  claim(0, 6, size, 1);

  const centres = ALIGNMENT_CENTRES[version - 1] ?? [];
  const last = centres.length - 1;
  for (let a = 0; a <= last; a += 1) {
    for (let b = 0; b <= last; b += 1) {
      // The three that would sit on a finder are not printed.
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      claim(centres[a]! - 2, centres[b]! - 2, 5, 5);
    }
  }

  if (version >= 7) {
    claim(0, size - 11, 6, 3);
    claim(size - 11, 0, 3, 6);
  }

  return reserved;
}

/** How many bits the character count takes, by mode and version (ISO/IEC 18004 table 3). */
function countBits(mode: number, version: number): number {
  const byMode: Record<number, readonly [number, number, number]> = {
    0b0001: [10, 12, 14], // numeric
    0b0010: [9, 11, 13], // alphanumeric
    0b0100: [8, 16, 16], // byte
  };
  const widths = byMode[mode];
  if (widths === undefined) throw new Error(`mode ${mode.toString(2)} is not decoded here`);
  const [small, medium, large] = widths;
  return version <= 9 ? small : version <= 26 ? medium : large;
}

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Read segments until the terminator, the end of the data, or a mode this does not handle. */
function parseSegments(codewords: readonly number[], version: number): string {
  let at = 0;
  const take = (count: number): number => {
    let value = 0;
    for (let taken = 0; taken < count; taken += 1) {
      const byte = codewords[at >> 3];
      if (byte === undefined) throw new Error('ran off the end of the codewords');
      value = (value << 1) | ((byte >> (7 - (at & 7))) & 1);
      at += 1;
    }
    return value;
  };

  let text = '';
  for (;;) {
    if (at + 4 > codewords.length * 8) break;
    const mode = take(4);
    if (mode === 0b0000) break; // terminator
    const count = take(countBits(mode, version));

    if (mode === 0b0100) {
      const bytes = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) bytes[index] = take(8);
      text += new TextDecoder().decode(bytes);
      continue;
    }

    if (mode === 0b0001) {
      let left = count;
      while (left >= 3) {
        text += String(take(10)).padStart(3, '0');
        left -= 3;
      }
      if (left === 2) text += String(take(7)).padStart(2, '0');
      else if (left === 1) text += String(take(4));
      continue;
    }

    if (mode === 0b0010) {
      let left = count;
      while (left >= 2) {
        const pair = take(11);
        text += ALPHANUMERIC[Math.floor(pair / 45)]! + ALPHANUMERIC[pair % 45]!;
        left -= 2;
      }
      if (left === 1) text += ALPHANUMERIC[take(6)]!;
      continue;
    }

    throw new Error(`mode ${mode.toString(2)} is not decoded here`);
  }

  return text;
}
