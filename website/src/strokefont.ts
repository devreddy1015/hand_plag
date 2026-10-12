/**
 * Handwriting fonts turned back into pen strokes (browser only).
 *
 * A handwriting font is a picture of pen strokes, filled in: its letters are
 * outlines, drawn as thick as the designer liked, the same weight wherever
 * the pen went. Filled in, they read as a marker, not a pen. A real line from
 * a ballpoint is thin — an eighth of the height of a small letter — and it
 * thins where the pen touches down and lifts off, darkens where two strokes
 * cross, and follows the direction the hand moved.
 *
 * So each letter of the font is drawn once, large, and thinned back to the
 * line through the middle of every stroke: the path the pen took. That path
 * is what gets written, with whichever pen is chosen, like the letters of a
 * hand written on the pad.
 */
import type { StrokeGlyph } from './engine';
import { luminance, vectorize } from './import/vectorize';

/** Size letters are drawn at to be traced: big enough that a thin stroke is still a stroke. */
const EM = 160;
/** Room above and below the baseline, in em. */
const ASCENT = 1.15;
const DESCENT = 0.55;

const cache = new Map<string, StrokeGlyph | null>();
let canvas: HTMLCanvasElement | null = null;

/**
 * The pen strokes of one letter in a font, in em units (baseline at 0, y
 * down), or null when the letter cannot be traced cleanly — a shaped script,
 * a symbol, a letter the font does not have.
 */
export function penGlyph(family: string, unit: string): StrokeGlyph | null {
  const key = `${family}\u0000${unit}`;
  let glyph = cache.get(key);
  if (glyph === undefined) {
    glyph = trace(family, unit);
    cache.set(key, glyph);
  }
  return glyph;
}

function trace(family: string, unit: string): StrokeGlyph | null {
  if (/\s/.test(unit)) return null;
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.font = `${EM}px "${family}"`;
  const advance = ctx.measureText(unit).width;
  if (!(advance > 0)) return null;
  // Room either side for letters that reach past their advance.
  const pad = Math.round(EM * 0.35);
  const width = Math.ceil(advance + pad * 2);
  const height = Math.ceil(EM * (ASCENT + DESCENT));
  const baseline = Math.round(EM * ASCENT);
  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = `${EM}px "${family}"`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(unit, pad, baseline);

  const lum = luminance(ctx.getImageData(0, 0, width, height).data);
  const traced = vectorize(lum, width, height, null, {
    threshold: 128,
    minSpeck: 6,
    solids: false,
    // Thinning grows whiskers about half a stroke long; the short tail of an
    // "a" or the arm of an "r" is longer than that and must survive.
    spurWidths: 0.7,
    extendEnds: true,
    epsilon: 0.6,
  });
  if (!traced || traced.paths.length === 0 || traced.paths.length > 12) return null;

  const strokes = traced.paths.map((path) => {
    const pts: number[] = [];
    for (let k = 0; k < path.pts.length; k += 2) pts.push((path.pts[k] - pad) / EM, (path.pts[k + 1] - baseline) / EM);
    return naturalWay(pts, path.closed);
  });
  return { strokes: naturalOrder(strokes), advance: advance / EM };
}

/**
 * Run a traced stroke the way a hand writes it. Thinning a letter gives its
 * lines but not which way the pen went, and that matters: a down-stroke is
 * pressed harder than an up-stroke, a stroke starts and ends differently, and
 * a writer makes each letter the same way every time. So a stroke that runs
 * mostly up and down is written downwards, one that runs across from left to
 * right, and a loop anticlockwise from its top, as an "o" is.
 */
export function naturalWay(pts: number[], closed: boolean): Float32Array {
  const n = pts.length / 2;
  let order: number[] = Array.from({ length: n }, (_, i) => i);
  if (closed && n >= 3) {
    // Start at the top of the loop, and go round to the left from there.
    let top = 0;
    for (let i = 1; i < n; i++) if (pts[i * 2 + 1] < pts[top * 2 + 1] - 1e-6 || (Math.abs(pts[i * 2 + 1] - pts[top * 2 + 1]) <= 1e-6 && pts[i * 2] > pts[top * 2])) top = i;
    order = order.map((_, k) => (top + k) % n);
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
    }
    // y points down, so a loop that runs anticlockwise on the page has a negative area.
    if (area > 0) order = [order[0], ...order.slice(1).reverse()];
  } else if (n >= 2) {
    const dx = pts[(n - 1) * 2] - pts[0];
    const dy = pts[(n - 1) * 2 + 1] - pts[1];
    const backwards = Math.abs(dy) >= Math.abs(dx) * 0.6 ? dy < 0 : dx < 0;
    if (backwards) order.reverse();
  }
  const out: number[] = [];
  for (const i of order) out.push(pts[i * 2], pts[i * 2 + 1], 1);
  // A closed loop goes round once more by a hair, so the join does not show.
  if (closed && out.length >= 6) out.push(out[0], out[1], 1);
  return Float32Array.from(out);
}

/** The order a letter's strokes are written in: its main strokes from left to right, then the dots and short bars. */
function naturalOrder(strokes: Float32Array[]): Float32Array[] {
  const length = (s: Float32Array) => {
    let total = 0;
    for (let i = 3; i < s.length; i += 3) total += Math.hypot(s[i] - s[i - 3], s[i + 1] - s[i - 2]);
    return total;
  };
  const minor = (s: Float32Array) => (length(s) < 0.15 ? 1 : 0);
  return [...strokes].sort((a, b) => minor(a) - minor(b) || a[0] - b[0]);
}
