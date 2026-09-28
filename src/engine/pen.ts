/**
 * Pens, and how each one lays down a line.
 *
 * A letter from a font arrives as a filled outline; a line drawn by hand —
 * an underline, a diagram, a letter from your own handwriting — arrives as
 * the path the pen travelled. Drawing that path at one fixed width is what
 * makes a line look plotted rather than written. A real pen varies:
 *
 *   - it touches down lightly and lifts off lighter still, so strokes taper;
 *   - pressure comes and goes along the stroke;
 *   - a nib is a short blade, broad across and fine along the direction it
 *     is held at.
 *
 * So each stroke is turned into its own outline, wide where the pen pressed
 * and narrow where it did not, and filled once — which keeps the ink even
 * where the stroke doubles back on itself, as ink on paper is.
 */
import type { PenType } from './types';

export interface PenStyle {
  /** Extra outline on font letters at full pressure, as a fraction of the font size. */
  strokeWeight: number;
  /** Width of a drawn line (underline, diagram, stroke letter), as a fraction of the font size. */
  lineWeight: number;
  /** Ink bleed blur radius in millimetres. */
  bleed: number;
  bleedAlpha: number;
  alpha: number;
  /** Fraction of the stroke knocked out by the tooth of the paper. */
  grain: number;
  /**
   * A chisel or flexible nib lays down ink across its width, so strokes across
   * the nib are broad and strokes along it are fine. `nib` is that width as a
   * fraction of the font size, `nibAngle` the angle the nib is held at.
   */
  nib: number;
  nibAngle: number;
  /** How much ink pools where the pen is set down. */
  pooling: number;
  /** How unevenly the ink goes down: 0 is flat colour. */
  density: number;
  /** Ink that dries darker at the edge of a stroke, as gel and fountain ink do. */
  edge: number;
  /** How far a stroke thins as the pen touches down and lifts off (0..1). */
  taper: number;
}

export const PENS: Record<PenType, PenStyle> = {
  ballpoint: {
    strokeWeight: 0.012,
    lineWeight: 0.052,
    bleed: 0.05,
    bleedAlpha: 0.25,
    alpha: 0.95,
    grain: 0.05,
    nib: 0,
    nibAngle: 0,
    pooling: 0.5,
    density: 0.2,
    edge: 0,
    taper: 0.45,
  },
  gel: {
    strokeWeight: 0.024,
    lineWeight: 0.066,
    bleed: 0.08,
    bleedAlpha: 0.35,
    alpha: 1,
    grain: 0,
    nib: 0,
    nibAngle: 0,
    pooling: 0.7,
    density: 0.12,
    edge: 0.35,
    taper: 0.25,
  },
  rollerball: {
    strokeWeight: 0.018,
    lineWeight: 0.06,
    bleed: 0.11,
    bleedAlpha: 0.4,
    alpha: 0.97,
    grain: 0,
    nib: 0.02,
    nibAngle: 40,
    pooling: 0.9,
    density: 0.16,
    edge: 0.2,
    taper: 0.3,
  },
  fountain: {
    strokeWeight: 0.016,
    lineWeight: 0.045,
    bleed: 0.15,
    bleedAlpha: 0.45,
    alpha: 0.93,
    grain: 0,
    nib: 0.055,
    nibAngle: 42,
    pooling: 1.1,
    density: 0.24,
    edge: 0.45,
    taper: 0.35,
  },
  calligraphy: {
    strokeWeight: 0.008,
    lineWeight: 0.03,
    bleed: 0.12,
    bleedAlpha: 0.4,
    alpha: 0.96,
    grain: 0,
    nib: 0.13,
    nibAngle: 40,
    pooling: 1.3,
    density: 0.2,
    edge: 0.4,
    taper: 0.2,
  },
  felt: {
    strokeWeight: 0.048,
    lineWeight: 0.1,
    bleed: 0.18,
    bleedAlpha: 0.5,
    alpha: 1,
    grain: 0.02,
    nib: 0,
    nibAngle: 0,
    pooling: 0.4,
    density: 0.1,
    edge: 0.15,
    taper: 0.12,
  },
  pencil: {
    strokeWeight: 0.004,
    lineWeight: 0.05,
    bleed: 0.03,
    bleedAlpha: 0.2,
    alpha: 0.78,
    grain: 0.5,
    nib: 0.018,
    nibAngle: 55,
    pooling: 0,
    density: 0.35,
    edge: 0,
    taper: 0.5,
  },
};

export function penFor(type: PenType): PenStyle {
  return PENS[type] ?? PENS.ballpoint;
}

/** Anything a filled polygon can be traced onto. */
export interface PolygonSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

export interface StrokeShape {
  /** Width of the line at full pressure, in the units of the points. */
  width: number;
  /** Nib width across the stroke, and the angle it is held at (radians). */
  nib: number;
  nibAngle: number;
  /** How far the ends thin, 0..1. */
  taper: number;
  /** Thin the start (the pen touching down). */
  taperStart: boolean;
  /** Thin the end (the pen lifting off). */
  taperEnd: boolean;
  /** Length over which a taper happens, in the units of the points. */
  taperLength: number;
}

interface Sample {
  x: number;
  y: number;
  p: number;
}

/**
 * Sample a smooth curve through the points: each point is a control point and
 * the curve runs through the midpoints between them, which is how a hand
 * rounds off a polyline. `step` is the spacing of the samples.
 */
export function smoothSamples(points: ArrayLike<number>, stride: 2 | 3, step: number): Sample[] {
  const n = Math.floor(points.length / stride);
  const at = (i: number): Sample => ({
    x: points[i * stride],
    y: points[i * stride + 1],
    p: stride === 3 ? points[i * stride + 2] : 1,
  });
  if (n === 0) return [];
  if (n === 1) return [at(0)];
  if (n === 2) return lineSamples(at(0), at(1), step);

  const out: Sample[] = [at(0)];
  let prev = at(0);
  for (let i = 1; i < n - 1; i++) {
    const c = at(i);
    const next = at(i + 1);
    const end: Sample =
      i === n - 2 ? next : { x: (c.x + next.x) / 2, y: (c.y + next.y) / 2, p: (c.p + next.p) / 2 };
    const length = Math.hypot(c.x - prev.x, c.y - prev.y) + Math.hypot(end.x - c.x, end.y - c.y);
    const steps = Math.max(1, Math.min(64, Math.ceil(length / step)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const d = t * t;
      out.push({ x: a * prev.x + b * c.x + d * end.x, y: a * prev.y + b * c.y + d * end.y, p: a * prev.p + b * c.p + d * end.p });
    }
    prev = end;
  }
  return out;
}

function lineSamples(a: Sample, b: Sample, step: number): Sample[] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.min(96, Math.ceil(length / step)));
  const out: Sample[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
  }
  return out;
}

/**
 * Trace the outline of a pen stroke: the left edge forwards, a round end, the
 * right edge back, a round start. One closed polygon, so it fills evenly.
 */
export function tracePenStroke(sink: PolygonSink, samples: Sample[], shape: StrokeShape): void {
  const n = samples.length;
  if (n === 0) return;
  if (n === 1 || pathLength(samples) < shape.width * 0.25) {
    const s = samples[0];
    const r = Math.max(0.05, (shape.width * (0.6 + 0.4 * s.p)) / 2);
    circle(sink, s.x, s.y, r);
    return;
  }

  // Distance along the stroke, for the tapers.
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) along[i] = along[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  const total = along[n - 1];
  const taperLength = Math.min(shape.taperLength, total * 0.4);

  const left: number[] = [];
  const right: number[] = [];
  const dirs: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const angle = Math.atan2(dy, dx);
    dirs.push(angle);

    let w = shape.width * (0.55 + 0.45 * clamp01(samples[i].p));
    if (shape.nib > 0) {
      // Broad across the nib, fine along it.
      w = Math.max(w * 0.45, w * 0.45 + shape.nib * Math.abs(Math.sin(angle - shape.nibAngle)));
    }
    if (taperLength > 0) {
      if (shape.taperStart) w *= 1 - shape.taper * (1 - ease(along[i] / taperLength));
      if (shape.taperEnd) w *= 1 - shape.taper * 1.2 * (1 - ease((total - along[i]) / taperLength));
    }
    const half = Math.max(0.04, w / 2);
    const nx = -dy * half;
    const ny = dx * half;
    left.push(samples[i].x + nx, samples[i].y + ny);
    right.push(samples[i].x - nx, samples[i].y - ny);
  }

  sink.moveTo(left[0], left[1]);
  for (let i = 1; i < n; i++) sink.lineTo(left[i * 2], left[i * 2 + 1]);
  cap(sink, left, right, n - 1, dirs[n - 1], false);
  for (let i = n - 1; i >= 0; i--) sink.lineTo(right[i * 2], right[i * 2 + 1]);
  cap(sink, left, right, 0, dirs[0], true);
  sink.closePath();
}

/** A half circle joining the two edges at one end of the stroke. */
function cap(sink: PolygonSink, left: number[], right: number[], i: number, dir: number, start: boolean): void {
  const r = Math.hypot(left[i * 2] - right[i * 2], left[i * 2 + 1] - right[i * 2 + 1]) / 2;
  const cx = (left[i * 2] + right[i * 2]) / 2;
  const cy = (left[i * 2 + 1] + right[i * 2 + 1]) / 2;
  // The end cap runs from the left edge round the front to the right edge;
  // the start cap from the right edge round the back to the left.
  const from = start ? dir - Math.PI / 2 : dir + Math.PI / 2;
  const STEPS = 6;
  for (let k = 1; k < STEPS; k++) {
    const a = from - (Math.PI * k) / STEPS;
    sink.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
}

function circle(sink: PolygonSink, x: number, y: number, r: number): void {
  const STEPS = 14;
  sink.moveTo(x + r, y);
  for (let k = 1; k < STEPS; k++) {
    const a = (Math.PI * 2 * k) / STEPS;
    sink.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  sink.closePath();
}

function pathLength(samples: Sample[]): number {
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  return total;
}

function ease(t: number): number {
  const x = clamp01(t);
  return x * (2 - x);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
