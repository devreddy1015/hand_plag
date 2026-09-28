/**
 * Letter shapes, and why no two copies of a letter come out the same.
 *
 * A font draws every "e" identically. Moving and tilting the copies about
 * hides that from a glance, but not from anyone who looks: the loop is the
 * same size, the tail ends in the same place, the bowl has the same width.
 * That sameness is what gives a handwriting font away.
 *
 * So each letter is bent before it is drawn. The bend is smooth — nobody's
 * pen jumps — and it comes in two layers, the way variation does in a real
 * hand:
 *
 *   - a habitual form: every writer has two or three ways of making a
 *     letter, and each is consistent. This layer is seeded by the letter and
 *     the variant, so it repeats exactly as a habit repeats.
 *   - the copy itself: smaller, and different every time.
 *
 * Both change the things that really do vary from one copy of a letter to
 * the next — how tall the ascender is, how far the descender drops, how wide
 * the bowl is, where a loop closes — rather than only where the letter sits.
 *
 * Coordinates are em units (1 = the font size), origin on the baseline at
 * the left of the letter, y pointing down, which is how a canvas draws text.
 */
import { clamp, gaussian, hashInts, hashString, mulberry32, smoothstep } from './random';

export const OP_MOVE = 0;
export const OP_LINE = 1;
export const OP_QUAD = 2;
export const OP_CUBIC = 3;
export const OP_CLOSE = 4;

/** A glyph outline: each opcode followed by its coordinates, in em units. */
export type Outline = Float32Array;

/** Number of coordinates that follow each opcode. */
const ARITY = [2, 2, 4, 6, 0];

/** A letter written as pen strokes: from your own hand, or the symbol set. */
export interface StrokeGlyph {
  /** Each stroke is a run of x, y, pressure triples, in em units. */
  strokes: Float32Array[];
  /** Distance to the next letter, in em. */
  advance: number;
}

/** Where the drawing engine gets letter shapes from. */
export interface GlyphShapes {
  /** x-height as a fraction of the font size, for the warp's zones. */
  xHeight: number;
  /** Capital height as a fraction of the font size. */
  capHeight?: number;
  /** The font joins its letters, so the ends of each letter must stay put. */
  connected: boolean;
  /** The font's outline for a unit, or null to let the browser draw it. */
  outline(unit: string): Outline | null;
  /** A stroke-drawn letter for this unit, when the hand has one. */
  strokeGlyph?(unit: string, variant: number): StrokeGlyph | null;
  /** Stroke weight of a stroke-drawn letter, as a fraction of the font size. */
  strokeWeight?: number;
}

/** Collects path commands into an outline. */
export class OutlineBuilder {
  private data: number[] = [];
  moveTo(x: number, y: number): void {
    this.data.push(OP_MOVE, x, y);
  }
  lineTo(x: number, y: number): void {
    this.data.push(OP_LINE, x, y);
  }
  quadTo(cx: number, cy: number, x: number, y: number): void {
    this.data.push(OP_QUAD, cx, cy, x, y);
  }
  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.data.push(OP_CUBIC, c1x, c1y, c2x, c2y, x, y);
  }
  close(): void {
    this.data.push(OP_CLOSE);
  }
  get empty(): boolean {
    return this.data.length === 0;
  }
  done(): Outline {
    return Float32Array.from(this.data);
  }
}

/** Visit every point of an outline, in order. Control points count too. */
export function forEachPoint(outline: Outline, visit: (x: number, y: number) => void): void {
  for (let i = 0; i < outline.length; ) {
    const op = outline[i++];
    const n = ARITY[op] ?? 0;
    for (let k = 0; k < n; k += 2) visit(outline[i + k], outline[i + k + 1]);
    i += n;
  }
}

/** Something a path can be traced onto: a canvas context, or a Path2D. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/**
 * Trace an outline onto a path, bent by `warp` and scaled by `size`. The warp
 * is applied to control points as well as end points; it is smooth enough
 * that the curves stay curves.
 */
export function traceOutline(sink: PathSink, outline: Outline, size: number, warp: Warp | null): void {
  const p = [0, 0];
  const at = (x: number, y: number): [number, number] => {
    if (warp) {
      warp(x, y, p);
      return [p[0] * size, p[1] * size];
    }
    return [x * size, y * size];
  };
  for (let i = 0; i < outline.length; ) {
    const op = outline[i++];
    if (op === OP_MOVE) {
      const [x, y] = at(outline[i], outline[i + 1]);
      sink.moveTo(x, y);
      i += 2;
    } else if (op === OP_LINE) {
      const [x, y] = at(outline[i], outline[i + 1]);
      sink.lineTo(x, y);
      i += 2;
    } else if (op === OP_QUAD) {
      const [cx, cy] = at(outline[i], outline[i + 1]);
      const [x, y] = at(outline[i + 2], outline[i + 3]);
      sink.quadraticCurveTo(cx, cy, x, y);
      i += 4;
    } else if (op === OP_CUBIC) {
      const [c1x, c1y] = at(outline[i], outline[i + 1]);
      const [c2x, c2y] = at(outline[i + 2], outline[i + 3]);
      const [x, y] = at(outline[i + 4], outline[i + 5]);
      sink.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
      i += 6;
    } else {
      sink.closePath();
    }
  }
}

/** Maps a point of the letter (em units) to where the pen actually put it. */
export type Warp = (x: number, y: number, out: number[]) => void;

export interface WarpParams {
  /** Overall strength. 0 leaves the letter as the font drew it; 1 is a natural hand. */
  amount: number;
  /** The writer: shared by every letter of one document. */
  handSeed: number;
  /** The letter being written. */
  unit: string;
  /** Which of the writer's habitual forms of this letter. */
  variant: number;
  /** This one copy of it. */
  instanceSeed: number;
  /** Width of the letter in em, so the bend is measured across the letter itself. */
  advance: number;
  /** x-height in em. */
  xHeight: number;
  /** Keep the left and right ends still, so the joins of a cursive hand still meet. */
  pinEnds: boolean;
}

/**
 * One layer of variation: how the ascender, descender, x-height and width
 * differ from the font's, and a few local bends where a loop opens or a
 * stroke ends somewhere else.
 */
interface Layer {
  mid: number;
  asc: number;
  desc: number;
  width: number;
  /** Local bends: centre x, centre y, radius², shift x, shift y. */
  bumps: number[];
}

/** Standard deviations of each layer at amount 1, in em or as a ratio. */
const FORM = { mid: 0.025, asc: 0.07, desc: 0.09, width: 0.04, bump: 0.019, bumps: 3 };
const COPY = { mid: 0.014, asc: 0.04, desc: 0.05, width: 0.024, bump: 0.012, bumps: 2 };

function makeLayer(seed: number, sd: typeof FORM, amount: number, advance: number, xHeight: number): Layer {
  const r = mulberry32(seed);
  const bumps: number[] = [];
  for (let i = 0; i < sd.bumps; i++) {
    // Wide, gentle bends: a narrow one would kink a stroke rather than reshape it.
    const radius = (0.24 + r() * 0.14) * Math.max(0.6, xHeight / 0.45);
    bumps.push(
      advance * (0.1 + r() * 0.8),
      -xHeight * (r() * 1.5 - 0.15),
      radius * radius,
      gaussian(r) * sd.bump * amount,
      gaussian(r) * sd.bump * amount,
    );
  }
  return {
    mid: gaussian(r) * sd.mid * amount,
    asc: gaussian(r) * sd.asc * amount,
    desc: gaussian(r) * sd.desc * amount,
    width: gaussian(r) * sd.width * amount,
    bumps,
  };
}

function applyLayer(layer: Layer, x: number, y: number, cx: number, xHeight: number, out: number[]): void {
  // Vertical zones: the body of the letter, what rises above it, what hangs below.
  let ny = y * (1 + layer.mid);
  if (y < -xHeight) ny = -xHeight * (1 + layer.mid) + (y + xHeight) * (1 + layer.asc);
  else if (y > 0) ny = y * (1 + layer.desc);
  let nx = cx + (x - cx) * (1 + layer.width);
  const b = layer.bumps;
  for (let i = 0; i < b.length; i += 5) {
    const dx = x - b[i];
    const dy = y - b[i + 1];
    const f = Math.exp(-(dx * dx + dy * dy) / b[i + 2]);
    nx += b[i + 3] * f;
    ny += b[i + 4] * f;
  }
  out[0] = nx;
  out[1] = ny;
}

/** Build the bend for one copy of one letter, or null when there is to be none. */
export function createWarp(p: WarpParams): Warp | null {
  const amount = clamp(p.amount, 0, 3);
  if (amount < 0.01) return null;
  const advance = Math.max(0.1, p.advance);
  const xHeight = clamp(p.xHeight, 0.2, 0.8);
  const cx = advance / 2;
  const form = makeLayer(hashInts(p.handSeed, hashString(p.unit), p.variant, 0xf0e), FORM, amount, advance, xHeight);
  const copy = makeLayer(hashInts(p.instanceSeed, 0xc0b1), COPY, amount, advance, xHeight);
  const pin = p.pinEnds;
  const edge = Math.min(0.14, advance * 0.3);
  const mid = [0, 0];
  return (x, y, out) => {
    applyLayer(form, x, y, cx, xHeight, mid);
    applyLayer(copy, mid[0], mid[1], cx, xHeight, out);
    if (pin) {
      // Fade the bend out towards the letter's edges, where it joins its neighbours.
      const w = smoothstep(Math.min(x, advance - x) / edge);
      out[0] = x + (out[0] - x) * w;
      out[1] = y + (out[1] - y) * w;
    }
  };
}

/** Bend a stroke glyph's points in place into a new array. */
export function warpStroke(stroke: Float32Array, warp: Warp | null): Float32Array {
  if (!warp) return stroke;
  const out = new Float32Array(stroke.length);
  const p = [0, 0];
  for (let i = 0; i < stroke.length; i += 3) {
    warp(stroke[i], stroke[i + 1], p);
    out[i] = p[0];
    out[i + 1] = p[1];
    out[i + 2] = stroke[i + 2];
  }
  return out;
}

/**
 * The inked area of an outline and the extent of its ink, in em². Contours
 * wind one way round and holes the other, so the signed areas sum to the ink.
 */
export function outlineInk(outline: Outline): { area: number; minX: number; maxX: number; minY: number; maxY: number } {
  let area = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  const edge = (x: number, y: number) => {
    area += px * y - x * py;
    px = x;
    py = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  for (let i = 0; i < outline.length; ) {
    const op = outline[i++];
    if (op === OP_MOVE) {
      area += px * sy - sx * py;
      sx = px = outline[i];
      sy = py = outline[i + 1];
      edge(px, py);
      i += 2;
    } else if (op === OP_LINE) {
      edge(outline[i], outline[i + 1]);
      i += 2;
    } else if (op === OP_QUAD) {
      const x0 = px;
      const y0 = py;
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const c = t * t;
        edge(a * x0 + b * outline[i] + c * outline[i + 2], a * y0 + b * outline[i + 1] + c * outline[i + 3]);
      }
      i += 4;
    } else if (op === OP_CUBIC) {
      const x0 = px;
      const y0 = py;
      for (let s = 1; s <= 10; s++) {
        const t = s / 10;
        const a = (1 - t) ** 3;
        const b = 3 * (1 - t) ** 2 * t;
        const c = 3 * (1 - t) * t * t;
        const d = t ** 3;
        edge(
          a * x0 + b * outline[i] + c * outline[i + 2] + d * outline[i + 4],
          a * y0 + b * outline[i + 1] + c * outline[i + 3] + d * outline[i + 5],
        );
      }
      i += 6;
    } else {
      edge(sx, sy);
    }
  }
  area += px * sy - sx * py;
  return { area: Math.abs(area) / 2, minX, maxX, minY, maxY };
}

/**
 * How thick the font's pen is, in em: a hyphen is one straight stroke, so its
 * inked area over its length is the width of the line. Falls back to a
 * middling weight when the font has no usable hyphen.
 */
export function penWeightOf(hyphen: Outline | null): number {
  if (!hyphen || hyphen.length === 0) return 0.06;
  const ink = outlineInk(hyphen);
  const length = ink.maxX - ink.minX;
  if (!(length > 0.05) || !(ink.area > 0)) return 0.06;
  // A hyphen thins at its ends, so its average width is a little under the pen's.
  return clamp((ink.area / length) * 1.2, 0.025, 0.16);
}
