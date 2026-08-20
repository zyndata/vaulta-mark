/**
 * @vitest-environment jsdom
 *
 * One bookmark's address as a QR code (`src/ui/qr.ts`).
 *
 * The failure this file exists for is silent. A QR code that encodes the wrong bytes still looks
 * like a QR code, still draws, and is only discovered by someone standing in front of a monitor
 * with a phone, holding an address that is not the one they saved — or nothing at all. Nothing in
 * the extension can tell. So the symbols here are **read back**, by `test/helpers/qr-decode.ts`,
 * which walks the standard rather than calling the library that wrote them.
 *
 * That decoder is itself anchored first, against ISO/IEC 18004's own worked example: an independent
 * reader nobody has checked is exactly as much use as no reader at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QUIET_ZONE,
  canvasSize,
  drawQr,
  encodeQr,
  moduleSize,
  qrPanel,
  type QrMatrix,
} from '../../../src/ui/qr.js';
import { decodeQr } from '../../helpers/qr-decode.js';
import { installChromeMock, uninstallChromeMock } from '../../mocks/chrome.js';

/**
 * A recording stand-in for a 2D context. jsdom has the element but nothing behind it.
 *
 * `fillStyle` is declared `string` rather than the context's own union, which is what makes the
 * recorded style a string worth asserting on. It still satisfies `QrSurface` — a narrower property
 * type is assignable to a wider one — and `drawQr` only ever writes a colour to it.
 */
interface RecordingSurface {
  readonly calls: { style: string; rect: number[] }[];
  fillStyle: string;
  fillRect(x: number, y: number, width: number, height: number): void;
}

function recordingSurface(): RecordingSurface {
  const calls: { style: string; rect: number[] }[] = [];
  const surface: RecordingSurface = {
    calls,
    fillStyle: '#000000',
    fillRect(x, y, width, height) {
      calls.push({ style: surface.fillStyle, rect: [x, y, width, height] });
    },
  };
  return surface;
}

/** A matrix with a dark module wherever `dark` says, for testing the painting alone. */
function fakeMatrix(dark: readonly (readonly [number, number])[], size: number): QrMatrix {
  const set = new Set(dark.map(([row, column]) => `${String(row)}:${String(column)}`));
  return { size, isDark: (row, column) => set.has(`${String(row)}:${String(column)}`) };
}

beforeEach(() => {
  installChromeMock();
});

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

describe('the decoder these tests read symbols back with', () => {
  /*
   * ISO/IEC 18004 Annex I: the number 01234567 as a version-1, level-M symbol. The standard prints
   * the sixteen data codewords it produces, and they are what this asserts — every part of the
   * decoder (format information, the function-pattern map, the zigzag, the mask) has to be right
   * for the sequence to come out. The mask itself is deliberately not asserted: the library chooses
   * one by penalty score, which is its business, and the codewords are the same either way.
   */
  it("reads the standard's worked example back to the codewords the standard prints", async () => {
    const { qrcode } = await import('../../../src/vendor/qrcode-generator/qrcode.js');
    const code = qrcode(1, 'M');
    code.addData('01234567', 'Numeric');
    code.make();

    const decoded = decodeQr({
      size: code.getModuleCount(),
      isDark: (row, column) => code.isDark(row, column),
    });

    expect(decoded.version).toBe(1);
    expect(decoded.errorCorrectionLevel).toBe('M');
    expect(decoded.codewords.slice(0, 16)).toEqual([
      0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec,
      0x11,
    ]);
    expect(decoded.text).toBe('01234567');
  });
});

describe('encodeQr', () => {
  /*
   * The addresses are chosen for the two ways a URL breaks an encoder: length, which decides the
   * version and the character-count field, and non-ASCII, which decides whether the payload is
   * UTF-8 or a row of question marks. Every one is decoded back and compared character for
   * character — "it produced a symbol" is not the claim.
   */
  const addresses: readonly [string, string][] = [
    ['a plain one', 'https://example.com/'],
    [
      'a long one with query parameters',
      'https://shop.example.com/catalogue/item/9182734?colour=deep-teal&size=large&ref=vaultamark',
    ],
    ['one with a fragment and escapes', 'https://example.org/docs/a%20b/c?q=1+2#section-3'],
    ['a Cyrillic one', 'https://ru.wikipedia.org/wiki/Привет_мир'],
    ['a CJK host and an accented query', 'https://例え.テスト/ページ?q=café'],
  ];

  for (const [what, url] of addresses) {
    it(`round-trips ${what}`, async () => {
      const decoded = decodeQr(await encodeQr(url));
      expect(decoded.text).toBe(url);
    });
  }

  it('encodes at level L, which is what the comment above ERROR_CORRECTION argues for', async () => {
    expect(decodeQr(await encodeQr('https://example.com/')).errorCorrectionLevel).toBe('L');
  });

  it('picks the smallest version the address fits in', async () => {
    const small = await encodeQr('https://example.com/');
    const large = await encodeQr(`https://example.com/${'a'.repeat(120)}`);
    expect(small.size).toBeLessThan(large.size);
  });

  it('refuses an address no version can hold', async () => {
    await expect(encodeQr(`https://example.com/${'a'.repeat(4000)}`)).rejects.toBeDefined();
  });
});

describe('geometry', () => {
  const matrix = fakeMatrix([], 21);

  it('gives a module a whole number of pixels', () => {
    // 21 + 8 = 29 modules across; 264 / 29 is 9.1, so nine, and never nine-point-something.
    expect(moduleSize(matrix, 264)).toBe(9);
    expect(canvasSize(matrix, 9)).toBe(29 * 9);
  });

  it('never shrinks a module below one pixel', () => {
    expect(moduleSize(matrix, 4)).toBe(1);
  });
});

describe('drawQr', () => {
  it('paints the light background first, over the quiet zone as well', () => {
    const surface = recordingSurface();
    drawQr(surface, fakeMatrix([[0, 0]], 3), 2);

    const [background] = surface.calls;
    expect(background).toEqual({ style: '#ffffff', rect: [0, 0, (3 + QUIET_ZONE * 2) * 2, (3 + QUIET_ZONE * 2) * 2] });
  });

  it('offsets every dark module by the quiet zone', () => {
    const surface = recordingSurface();
    drawQr(surface, fakeMatrix([[0, 0], [2, 1]], 3), 10);

    const dark = surface.calls.slice(1);
    expect(dark).toEqual([
      { style: '#000000', rect: [QUIET_ZONE * 10, QUIET_ZONE * 10, 10, 10] },
      { style: '#000000', rect: [(1 + QUIET_ZONE) * 10, (2 + QUIET_ZONE) * 10, 10, 10] },
    ]);
  });

  it('paints nothing but the background for an empty matrix', () => {
    const surface = recordingSurface();
    drawQr(surface, fakeMatrix([], 5), 3);
    expect(surface.calls).toHaveLength(1);
  });
});

describe('qrPanel', () => {
  /** The panel paints in a microtask chain; nothing here is worth a timer. */
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it('says it is working, then replaces that with a named canvas', async () => {
    const surface = recordingSurface();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      surface as unknown as CanvasRenderingContext2D,
    );

    const panel = qrPanel({
      url: 'https://example.com/',
      encode: () => Promise.resolve(fakeMatrix([[1, 1]], 21)),
      pixels: 264,
    });
    document.body.append(panel);
    expect(panel.textContent).toContain('qrDrawing');

    await settle();

    const canvas = panel.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toBe('qrCanvasLabel');
    expect(canvas?.width).toBe(29 * 9);
    // The context was real enough to draw on, so the wiring from matrix to canvas is exercised
    // here rather than only in the browser.
    expect(surface.calls.length).toBeGreaterThan(1);
  });

  it('carries the sentence about where the address lands on the phone', () => {
    const panel = qrPanel({
      url: 'https://example.com/',
      encode: () => Promise.resolve(fakeMatrix([], 21)),
    });
    expect(panel.textContent).toContain('qrOrdinaryTab');
  });

  it('draws nothing rather than throwing when there is no 2D context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    const panel = qrPanel({
      url: 'https://example.com/',
      encode: () => Promise.resolve(fakeMatrix([[0, 0]], 21)),
    });
    document.body.append(panel);
    await settle();

    expect(panel.querySelector('canvas')).not.toBeNull();
  });

  it('says the address is too long when the encoder refuses it', async () => {
    const panel = qrPanel({
      url: 'https://example.com/',
      encode: () => Promise.reject(new Error('code length overflow')),
    });
    document.body.append(panel);
    await settle();

    expect(panel.textContent).toContain('qrTooLong');
    expect(panel.querySelector('canvas')).toBeNull();
  });

  /*
   * The dialog can be closed while the encoder is still loading its chunk, and `openDialog` removes
   * the whole subtree on close. Painting into a detached node is harmless, but reaching for a
   * canvas context on one is not worth finding out about in the field.
   */
  it('gives up when the dialog was closed before the symbol arrived', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const panel = qrPanel({
      url: 'https://example.com/',
      encode: () => Promise.resolve(fakeMatrix([[0, 0]], 21)),
    });
    // Never appended: `isConnected` is false, which is the state a closed dialog leaves behind.
    await settle();

    expect(panel.querySelector('canvas')).toBeNull();
    expect(getContext).not.toHaveBeenCalled();
  });
});
