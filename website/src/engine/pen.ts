/**
 * Pens, and how each one lays down a line.
 *
 * A letter from a font arrives as a filled outline; a line drawn by hand —
 * an underline, a diagram, a letter from your own handwriting — arrives as
 * the path the pen travelled. Drawing that path at one fixed width is what
 * makes a line look plotted rather than written. A real pen varies:
 *
 *   - it touches down lightly and lifts off lighter still, so strokes taper;
 *   - it slows into every turn and runs along the straights, and a slow pen
 *     leaves more ink than a fast one (see `penDynamics`);
 *   - a down-stroke, pulled towards the writer, is pressed harder than an
 *     up-stroke pushed away;
 *   - a nib is a short blade, broad across and fine along the direction it
 *     is held at.
 *
 * So each stroke is turned into its own outline, wide where the pen pressed
 * and narrow where it did not, and filled once — which keeps the ink even
 * where the stroke doubles back on itself, as ink on paper is.
 */
import { clamp, gaussian, type Rng } from './random';
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
  /** How deep a groove the pen presses into the paper: a ballpoint needs bearing down on, a felt tip hardly touches. */
  press: number;
  /** How much of the ink soaks into the sheet and shows on the other side of it. */
  soak: number;
  /** How much wider a slow stroke comes out than a fast one: liquid ink seeps, ballpoint paste hardly does. */
  flow: number;
  /** Pale streaks along a fast stroke where the ball ran short of ink (ballpoint burr striations). */
  striation: number;
  /** How readily the pen skips on a fast stroke, leaving a short gap. */
  skip: number;
  /** How often a stroke starts pale while the ball begins to roll (a ballpoint's inkless start). */
  dryStart: number;
}

const PENS: Record<PenType, PenStyle> = {
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
    press: 1,
    soak: 0.5,
    flow: 0.12,
    striation: 1,
    skip: 0.35,
    dryStart: 0.35,
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
    press: 0.6,
    soak: 0.95,
    flow: 0.2,
    striation: 0,
    skip: 0.5,
    dryStart: 0,
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
    press: 0.5,
    soak: 1.05,
    flow: 0.22,
    striation: 0.3,
    skip: 0.35,
    dryStart: 0.1,
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
    press: 0.35,
    soak: 1.15,
    flow: 0.3,
    striation: 0,
    skip: 0.12,
    dryStart: 0,
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
    press: 0.35,
    soak: 1.15,
    flow: 0.15,
    striation: 0,
    skip: 0.08,
    dryStart: 0,
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
    press: 0.15,
    soak: 1.4,
    flow: 0.24,
    striation: 0,
    skip: 0,
    dryStart: 0,
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
    press: 0.8,
    soak: 0.12,
    flow: 0.08,
    striation: 0,
    skip: 0,
    dryStart: 0,
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

export interface Sample {
  x: number;
  y: number;
  /** Pressure, 0..1 as recorded; up to about 1.3 once a slow pen has pressed in. */
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

/** Turns sharper than this (radians) end one movement of the hand and start the next. */
const CUSP = 1.7;

/**
 * How fast the pen moved along a stroke, and how hard it pressed.
 *
 * A hand does not move a pen at an even pace. A stroke is made of movements,
 * one between each cusp or change of bend and the next, and each has a pace
 * of its own (Lacquaniti, Terzuolo and Viviani): faster for a longer
 * movement — a big loop is drawn in about the time of a small one — and a
 * tenth or so faster or slower than the last time it was made. Within a
 * movement the pen slows into tight turns and runs on the straights, its
 * speed going with the cube root of the radius of the curve. A stroke starts
 * from rest, reaches its pace quickly and slows more gently to the lift.
 *
 * The pressure follows. A hand bears down on strokes it pulls towards itself
 * and eases off those it pushes away, so a down-stroke comes out heavier than
 * an up-stroke — the difference examiners look for to tell a person's writing
 * from a plotter's. And a slow pen lets more ink out than a fast one, by as
 * much as `flow` says.
 *
 * `size` is the font size in the units of the samples. Sets each sample's
 * pressure, and returns its speed: 1 is the pace of an ordinary curve, near 0
 * a stop, 2 and more a quick straight.
 */
export function penDynamics(samples: Sample[], rng: Rng, size: number, flow: number): Float32Array {
  const n = samples.length;
  const speed = new Float32Array(n);
  if (n < 3) {
    speed.fill(0.6);
    return speed;
  }
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) along[i] = along[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
  const total = along[n - 1];

  // The turn at each point, measured over a short span either side so the
  // steps between samples do not read as kinks.
  const span = size * 0.05;
  const turn = new Float32Array(n);
  const bend = new Int8Array(n);
  const radius = new Float32Array(n);
  let j = 0;
  let k = 1;
  for (let i = 0; i < n; i++) {
    while (j + 1 < i && along[i] - along[j + 1] >= span) j++;
    if (k <= i) k = i + 1;
    while (k < n - 1 && along[k] - along[i] < span) k++;
    const a = samples[Math.min(j, i)];
    const b = samples[i];
    const c = samples[Math.min(k, n - 1)];
    const ax = b.x - a.x;
    const ay = b.y - a.y;
    const bx = c.x - b.x;
    const by = c.y - b.y;
    const signed = ax * ax + ay * ay > 0 && bx * bx + by * by > 0 ? Math.atan2(ax * by - ay * bx, ax * bx + ay * by) : 0;
    const angle = Math.abs(signed);
    turn[i] = angle;
    // Which way the stroke bends here, when it bends enough to tell.
    bend[i] = angle < 0.08 ? 0 : signed > 0 ? 1 : -1;
    const reach = (along[Math.min(k, n - 1)] - along[Math.min(j, i)]) / 2;
    radius[i] = angle > 1e-4 && reach > 0 ? reach / angle : Infinity;
  }

  // Cut the stroke into movements, at cusps and where the bend changes side.
  const starts = [0];
  let side = 0;
  for (let i = 1; i < n - 1; i++) {
    const cusp = turn[i] > CUSP && turn[i] >= turn[i - 1] && turn[i] >= turn[i + 1];
    const inflection = bend[i] !== 0 && side !== 0 && bend[i] !== side;
    if (bend[i] !== 0) side = bend[i];
    if ((cusp || inflection) && along[i] - along[starts[starts.length - 1]] > size * 0.04) starts.push(i);
  }
  starts.push(n);
  const gains = new Float32Array(n);
  for (let m = 0; m + 1 < starts.length; m++) {
    const from = starts[m];
    const to = starts[m + 1];
    const length = along[to - 1] - along[from];
    const gain = clamp(Math.pow(Math.max(length, 1e-6) / (size * 0.4), 0.55), 0.6, 1.8) * Math.exp(gaussian(rng) * 0.1);
    gains.fill(gain, from, to);
  }

  const startRamp = Math.min(size * 0.12, total * 0.3);
  const endRamp = Math.min(size * 0.18, total * 0.35);
  for (let i = 0; i < n; i++) {
    const gain = gains[i];
    const r = clamp(radius[i] / (size * 0.25), 0.1, 16);
    const rest = (0.15 + 0.85 * ease(along[i] / Math.max(startRamp, 1e-6))) * (0.2 + 0.8 * ease((total - along[i]) / Math.max(endRamp, 1e-6)));
    // At a cusp the pen all but stops before it turns back.
    const stop = turn[i] > CUSP ? 0.35 : 1;
    speed[i] = Math.cbrt(r) * gain * rest * stop;
  }

  const phase = rng() * Math.PI * 2;
  const wavelength = size * (0.3 + rng() * 0.3);
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const down = (b.y - a.y) / len;
    const wobble = Math.sin(along[i] / wavelength + phase) * 0.06;
    const ink = clamp(1 + flow * (1 - speed[i]), 1 - flow, 1 + flow * 0.8);
    samples[i].p = clamp(samples[i].p * (0.8 + 0.2 * down + wobble) * ink, 0.25, 1.3);
  }
  return speed;
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

    let w = shape.width * (0.55 + 0.45 * clamp(samples[i].p, 0, 1.4));
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
