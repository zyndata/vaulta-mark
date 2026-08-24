/**
 * One bookmark's address as a QR code (ARCHITECTURE §17).
 *
 * The problem it solves is a workaround: the usual way to get a vaulted address onto a phone is to
 * mail it to yourself, which takes the address out of the vault and leaves it in an inbox for good.
 * A QR code moves it across the room and leaves nothing behind on this side.
 *
 * **It is drawn only when asked.** A QR that sat in the detail pane would be a plaintext address on
 * screen for anyone who glanced at the monitor, which is the case this product exists for.
 *
 * **It carries the address and nothing else.** A title and a note would push the symbol toward
 * version 40 and produce a chessboard no phone reads reliably.
 *
 * **It promises nothing about the phone.** There is no way to make a scanned link open privately:
 * Chrome for Android has no scanner in private tabs, iOS has no URL scheme for one, and an
 * `intent://` carrying `EXTRA_OPEN_NEW_INCOGNITO_TAB` is undocumented, scanner-dependent and fails
 * *silently* into an ordinary tab — which would leave someone believing they were private when they
 * were not. That is worse than promising nothing, so the panel promises nothing and says plainly
 * where the address is about to land.
 *
 * The encoder is vendored (§15) and reached through a **dynamic import**, so it is in neither the
 * worker's cold-start graph nor the manager's first paint. `encode` is injectable for the same
 * reason every callback in this directory is: `src/ui/**` renders, and a test should not have to
 * load 50 KB of Galois-field arithmetic to check that a label is on a canvas.
 */

import { h, msg, render } from './dom.js';

/** A square of dark and light modules. The only thing this module wants from an encoder. */
export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  readonly size: number;
  isDark(row: number, column: number): boolean;
}

export type QrEncoder = (text: string) => Promise<QrMatrix>;

/**
 * Light modules on every side, in modules. Four is the minimum ISO/IEC 18004 allows, and a symbol
 * drawn without one is the commonest reason a phone refuses to see a code that is right there on
 * the screen — the reader has nothing to tell it where the symbol stops.
 */
export const QUIET_ZONE = 4;

/**
 * Error correction level **L** (7 %), and that is a considered choice rather than a default taken.
 *
 * Error correction buys tolerance of damage: creases, ink spread, a coffee ring. This symbol is
 * displayed on a clean, self-lit screen for a few seconds and is never printed, so there is no
 * damage for it to tolerate. What it costs is real — a higher level pushes a long URL up a version
 * or two, and every extra version makes each module smaller in a dialog whose width is fixed.
 * Module size is what decides whether a phone camera resolves the thing at arm's length.
 */
const ERROR_CORRECTION = 'L';

/**
 * How wide the drawn symbol may be, in CSS pixels.
 *
 * `.vm-dialog` is `min(28rem, …)` with 1.25rem of padding a side, so about 408 px of content at the
 * default root size. This is comfortably inside that on a narrow window and large enough that a
 * version-10 symbol still gets whole-pixel modules.
 */
const PANEL_PIXELS = 264;

/**
 * The members of a 2D canvas context that `drawQr` uses.
 *
 * Narrowed to two so the drawing can be unit-tested: jsdom has an `HTMLCanvasElement` but no 2D
 * context behind it, and a `CanvasRenderingContext2D` that only exists in a real browser would put
 * the module placement — where an off-by-one is a symbol nothing can read — under E2E only. Same
 * reasoning as `ImageOps` in `src/thumbs/process.ts`.
 */
export interface QrSurface {
  /**
   * The real context's own type, not `string`. A canvas fill may be a gradient or a pattern, and a
   * narrower declaration here would make a `CanvasRenderingContext2D` fail to satisfy the interface
   * it was extracted from. Everything below assigns a colour.
   */
  fillStyle: CanvasFillStrokeStyles['fillStyle'];
  fillRect(x: number, y: number, width: number, height: number): void;
}

/**
 * The largest whole number of pixels a module may be, given a width to fit into.
 *
 * Whole pixels, deliberately. A fractional module size lets the browser resolve each edge whichever
 * way it likes, and a symbol whose modules are alternately 5 and 6 pixels wide is one a reader has
 * to work at. Never below 1, so an oversized symbol comes out too small to scan rather than as an
 * empty canvas.
 */
export function moduleSize(matrix: QrMatrix, pixels: number): number {
  return Math.max(1, Math.floor(pixels / (matrix.size + QUIET_ZONE * 2)));
}

/** The side of the drawn symbol, quiet zone included, at a given module size. */
export function canvasSize(matrix: QrMatrix, module: number): number {
  return (matrix.size + QUIET_ZONE * 2) * module;
}

/**
 * Paint the symbol, quiet zone and all.
 *
 * Black on white whatever the theme is. A QR code is a specification with a stated polarity — dark
 * modules on a light background — and while some readers cope with an inverted one, "some" is not
 * a thing to hand someone who is holding up a phone. So this is the one surface in the extension
 * that ignores `data-theme`. The quiet zone is painted here rather than left to CSS, which is what
 * separates the symbol from a dark window — `.vm-qr canvas` carries a comment saying nothing may
 * draw over it.
 */
export function drawQr(surface: QrSurface, matrix: QrMatrix, module: number): void {
  const side = canvasSize(matrix, module);
  surface.fillStyle = '#ffffff';
  surface.fillRect(0, 0, side, side);

  surface.fillStyle = '#000000';
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (!matrix.isDark(row, column)) continue;
      surface.fillRect((column + QUIET_ZONE) * module, (row + QUIET_ZONE) * module, module, module);
    }
  }
}

/**
 * UTF-8 bytes as one character each, which is what the vendored encoder's byte mode consumes.
 *
 * Its `addData(…, 'Byte')` takes the low byte of every character, so handing it a JavaScript string
 * directly would encode `café` as latin-1 and a Cyrillic or CJK host as a row of `?`. Upstream
 * solves this with a second file that replaces the library's `stringToBytes` with a UTF-8 routine
 * of its own; the platform already has one that is right about surrogate pairs, so we encode here
 * and vendor one file instead of two.
 */
function toBinaryString(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return binary;
}

/**
 * Encode `text`, loading the vendored generator on first use.
 *
 * The specifier is a relative string literal, which is the one shape `verify-no-remote-code.mjs`
 * permits (rule `dynamic-import`) and the one Rolldown can resolve at build time — so it becomes a
 * chunk inside the package rather than a fetch, and `scripts/check-budgets.mjs` asserts it stayed
 * out of the entry chunks.
 */
export const encodeQr: QrEncoder = async (text) => {
  const { qrcode } = await import('../vendor/qrcode-generator/qrcode.js');
  // 0 = "the smallest version this fits in", which is the only sensible answer: a fixed version
  // would either refuse ordinary URLs or draw a short one at four times the module count it needs.
  const code = qrcode(0, ERROR_CORRECTION);
  code.addData(toBinaryString(text), 'Byte');
  code.make();
  const size = code.getModuleCount();
  return { size, isDark: (row, column) => code.isDark(row, column) };
};

export interface QrPanelOptions {
  /** The address to encode. Nothing else about the bookmark goes into the symbol. */
  readonly url: string;
  /** Injected by tests; the vendored encoder otherwise. */
  readonly encode?: QrEncoder;
  /** Injected by tests; `PANEL_PIXELS` otherwise. */
  readonly pixels?: number;
}

/**
 * The dialog's body: the symbol, and the sentence about where the address is going to land.
 *
 * Returns at once and paints when the encoder resolves — the chunk is a disk read away, and a
 * dialog that opened only once it had arrived would look like a button that did nothing. A refusal
 * (the library throws on data no version can hold) becomes a sentence in the same slot: an address
 * that long cannot be scanned by anything, and saying so is the whole of what can be done about it.
 */
export function qrPanel(options: QrPanelOptions): HTMLElement {
  const slot = h('div', { class: 'vm-qr' });
  const root = h(
    'div',
    { class: 'vm-qr-panel' },
    slot,
    h('p', { class: 'vm-hint vm-small vm-muted' }, msg('qrOrdinaryTab')),
  );

  render(slot, h('p', { class: 'vm-small vm-muted', role: 'status' }, msg('qrDrawing')));

  const encode = options.encode ?? encodeQr;
  void (async () => {
    let matrix: QrMatrix;
    try {
      matrix = await encode(options.url);
    } catch {
      // The encoder throws strings rather than errors, and nothing it says is in `_locales` or fit
      // to read. What the user can act on is the one sentence below.
      render(slot, h('p', { class: 'vm-notice vm-notice--warning' }, msg('qrTooLong')));
      return;
    }
    // The dialog may already have been closed, and `openDialog` drops the whole subtree with it.
    if (!slot.isConnected) return;
    render(slot, canvasFor(matrix, options.pixels ?? PANEL_PIXELS));
  })();

  return root;
}

/**
 * The canvas, named for assistive technology.
 *
 * `role="img"` with a label rather than the URL as its text: a screen reader cannot scan a QR code,
 * the address is on the pane behind this dialog, and a hundred characters of query string read
 * aloud is not an accessible name.
 */
function canvasFor(matrix: QrMatrix, pixels: number): HTMLCanvasElement {
  const module = moduleSize(matrix, pixels);
  const side = canvasSize(matrix, module);
  const canvas = h('canvas', {
    width: side,
    height: side,
    role: 'img',
    'aria-label': msg('qrCanvasLabel'),
  });

  const context = canvas.getContext('2d');
  if (context !== null) drawQr(context, matrix, module);
  return canvas;
}
