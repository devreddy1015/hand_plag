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

  const strokes: Float32Array[] = [];
  for (const path of traced.paths) {
    const out: number[] = [];
    for (let k = 0; k < path.pts.length; k += 2) out.push((path.pts[k] - pad) / EM, (path.pts[k + 1] - baseline) / EM, 1);
    // A closed loop goes round once more by a hair, so the join does not show.
    if (path.closed && out.length >= 6) out.push(out[0], out[1], 1);
    strokes.push(Float32Array.from(out));
  }
  return { strokes, advance: advance / EM };
}

/** Forget the traced letters, when a font is replaced. */
export function forgetPenGlyphs(family?: string): void {
  if (family === undefined) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) if (key.startsWith(`${family}\u0000`)) cache.delete(key);
}
