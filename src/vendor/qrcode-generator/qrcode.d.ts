/**
 * Types for `qrcode.js`, the vendored copy of Kazuhiko Arase's `qrcode-generator` (§15).
 *
 * Hand-written, and deliberately **narrower than the library**. Upstream ships a `.d.ts` that
 * declares an ambient `var qrcode` plus a `declare module 'qrcode-generator'` — a shape for a
 * package on npm, which this is not: the file is source in this tree and is reached by a relative
 * import. It also describes `createImgTag`, `createSvgTag`, `createTableTag`, `createDataURL`,
 * `createASCII` and `renderTo2dContext`, none of which we call. Every one of those builds *markup*
 * or a `data:` URL from a string, and a type that offers them is an invitation to use one.
 *
 * So this declares the four members `src/ui/qr.ts` uses and nothing else. The rest of the library
 * is still in the bundle — it is one file, unmodified on purpose — but it is not reachable through
 * a name TypeScript will complete.
 */

/** 1 to 40; `0` asks the library for the smallest version the data fits in. */
export type TypeNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35
  | 36 | 37 | 38 | 39 | 40;

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export type Mode = 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji';

export interface QrCode {
  /**
   * Queue a segment. In `'Byte'` mode each character's low byte is one codeword, so the caller
   * hands it one character per byte — see `toBinaryString` in `src/ui/qr.ts`.
   */
  addData(data: string, mode?: Mode): void;
  /** Build the symbol. Everything below throws until this has been called. */
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}

export function qrcode(
  typeNumber: TypeNumber,
  errorCorrectionLevel: ErrorCorrectionLevel,
): QrCode;

