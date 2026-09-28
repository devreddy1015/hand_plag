/**
 * Drawing a traced diagram by hand.
 *
 * A diagram copied out in pen is not a printout in blue. Every line is drawn
 * once, from one end to the other, and comes out a little bowed and a little
 * unsteady; it stops just short of a corner or runs just past it; a circle
 * closes with an overlap; a solid bar is outlined and shaded with quick
 * parallel strokes rather than filled; an arrowhead is inked in. The labels
 * are written in the same hand as the rest of the page (that part is done by
 * the layout, which owns the letters).
 */
import { clamp, gaussian, type Rng } from './random';
import type { InkStroke, Sketch } from './types';

export interface SketchPlacement {
  /** Top-left corner and width of the figure on the page. Its height follows from the aspect. */
  x: number;
  y: number;
  width: number;
  /** Radians, about the figure's centre. */
  rotation: number;
}

export interface SketchStyle {
  rng: Rng;
  /** 0 = steady, 1 = very unsteady. 0.5 is natural. */
  messiness: number;
  /** Width of a pen line, in page units. */
  lineWidth: number;
  /** Page units per millimetre. */
  mm: number;
}

/** The pen strokes that draw a sketch at a given place on the page. */
export function sketchStrokes(sketch: Sketch, at: SketchPlacement, style: SketchStyle): InkStroke[] {
  const { rng, mm } = style;
  // A drawing made on the pad already wobbles the way its author's hand does.
  const m = clamp(style.messiness, 0, 1) * 2 * (sketch.handmade ? 0.15 : 1);
  const height = at.width / Math.max(0.05, sketch.aspect);
  const cx = at.x + at.width / 2;
  const cy = at.y + height / 2;
  const cos = Math.cos(at.rotation);
  const sin = Math.sin(at.rotation);
  const toPage = (x: number, y: number): [number, number] => {
    const px = x * at.width - at.width / 2;
    const py = y * at.width - height / 2;
    return [cx + px * cos - py * sin, cy + px * sin + py * cos];
  };
  const out: InkStroke[] = [];
  // The writer's own lean on each pattern: not quite 45 degrees, and not the same every time.
  const angles = [0, 1, 2, 3, 4, 5].map(() => (rng() - 0.5) * 12);

  // Lines drawn heavier in the original are pressed a little harder, never
  // drawn with a different pen.
  const widthOf = (weight: number) => style.lineWidth * clamp(0.88 + 0.22 * (weight - 1), 0.8, 1.45);

  for (const path of sketch.paths) {
    const pts: number[] = [];
    for (let k = 0; k < path.pts.length; k += 2) pts.push(...toPage(path.pts[k], path.pts[k + 1]));
    const length = polylineLength(pts, path.closed === true);
    if (pts.length === 2 || length < 0.35 * mm) {
      // A dot: a point on a graph, the dot of an i in a traced label.
      out.push({ points: [{ x: pts[0], y: pts[1] }], width: widthOf(path.weight) * 0.75, opacity: 0.92, shade: gaussian(rng) * 0.15, taper: true });
      continue;
    }
    for (const stroke of handDrawn(pts, path.closed === true, length, m, mm, rng)) {
      out.push({
        points: stroke,
        width: widthOf(path.weight),
        opacity: clamp(0.9 + gaussian(rng) * 0.04, 0.8, 1),
        shade: clamp(gaussian(rng) * 0.18, -0.5, 0.5),
        taper: true,
      });
    }
  }

  for (const fill of sketch.fills) {
    const pts: number[] = [];
    for (let k = 0; k < fill.pts.length; k += 2) pts.push(...toPage(fill.pts[k], fill.pts[k + 1]));
    if (pts.length < 6) continue;
    const area = Math.abs(polygonArea(pts));
    if (area < (2.6 * mm) ** 2) {
      // Small enough to ink in: an arrowhead, a marker, a filled dot. Its
      // shape is the point of it, so it keeps its corners and only shakes a
      // little.
      const shaky = 0.05 * mm * m;
      const points: { x: number; y: number }[] = [];
      for (let k = 0; k < pts.length; k += 2) points.push({ x: pts[k] + gaussian(rng) * shaky, y: pts[k + 1] + gaussian(rng) * shaky });
      out.push({ points, width: style.lineWidth * 0.7, opacity: 0.95, shade: 0.1, taper: false, fill: true });
      continue;
    }
    const outline = handDrawn(pts, true, polylineLength(pts, true), m * 0.7, mm, rng)[0];
    if (!outline) continue;
    out.push({ points: outline, width: style.lineWidth, opacity: 0.92, shade: 0.05, taper: true });
    out.push(...shading(pts, fill.group ?? 0, fill.tone ?? 0.6, style, m, rng, angles));
  }
  return out;
}

/**
 * The ways a writer tells shaded areas apart: lines one way, the other way,
 * crossed, upright, level. Each colour group of a figure gets the next one.
 */
const SHADES: number[][] = [[45], [135], [45, 135], [90], [0], [60, 150]];

/**
 * Shade an area in its group's pattern. Darker fills are shaded closer, as a
 * writer presses on to make a dark bar look dark.
 */
function shading(pts: number[], group: number, tone: number, style: SketchStyle, m: number, rng: Rng, angles: number[]): InkStroke[] {
  const pattern = SHADES[group % SHADES.length];
  const spacing = style.mm * (2.1 - 1.1 * clamp(tone, 0, 1));
  const out: InkStroke[] = [];
  for (const base of pattern) out.push(...hatching(pts, style, m, rng, base + angles[group % angles.length], spacing));
  return out;
}

function polylineLength(pts: number[], closed: boolean): number {
  let total = 0;
  for (let k = 2; k < pts.length; k += 2) total += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
  if (closed && pts.length >= 4) total += Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]);
  return total;
}

function polygonArea(pts: number[]): number {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return a / 2;
}

/**
 * Resample a path along its length, keeping every corner, so the wobble can be
 * laid along it evenly and the corners still turn where they should.
 */
function resample(pts: number[], closed: boolean, step: number): { x: number; y: number; s: number }[] {
  const src = closed ? [...pts, pts[0], pts[1]] : pts;
  const out: { x: number; y: number; s: number }[] = [{ x: src[0], y: src[1], s: 0 }];
  let s = 0;
  for (let k = 2; k < src.length; k += 2) {
    const x0 = src[k - 2];
    const y0 = src[k - 1];
    const x1 = src[k];
    const y1 = src[k + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      out.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, s: s + len * t });
    }
    s += len;
  }
  return out;
}

/**
 * One path as the hand draws it: a slow bow across its length, a faster
 * tremor on top, and ends that stop short or run on. Returns one stroke, or
 * two when a long line is drawn in two goes.
 */
function handDrawn(pts: number[], closed: boolean, length: number, m: number, mm: number, rng: Rng): { x: number; y: number }[][] {
  const samples = resample(pts, closed, Math.max(0.6 * mm, Math.min(1.6 * mm, length / 24)));
  if (samples.length < 2) return [];
  const total = samples[samples.length - 1].s || 1;

  // The bow grows with the length of the line, but a hand does not wander far.
  const bow = gaussian(rng) * Math.min(0.55 * mm, 0.012 * total) * m;
  const tremor = Math.min(0.14 * mm, 0.01 * total + 0.03 * mm) * m;
  const phase = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;
  const wavelength = (5 + rng() * 4) * mm;

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const t = samples[i].s / total;
    const offset =
      bow * Math.sin(Math.PI * t) +
      tremor * (Math.sin((samples[i].s / wavelength) * Math.PI * 2 + phase) * 0.7 + Math.sin((samples[i].s / (wavelength * 0.37)) * Math.PI * 2 + phase2) * 0.3);
    points.push({ x: samples[i].x - dy * offset, y: samples[i].y + dx * offset });
  }

  if (closed) {
    // A loop is closed by running a little past where it started.
    const run = Math.min(points.length - 1, Math.max(1, Math.round(points.length * 0.04 + rng() * 2)));
    for (let i = 1; i <= run; i++) points.push({ x: points[i].x + gaussian(rng) * 0.08 * mm * m, y: points[i].y + gaussian(rng) * 0.08 * mm * m });
    return [points];
  }

  // Ends: most lines run a touch past where they should stop, some fall short.
  extend(points, true, clamp(0.25 + gaussian(rng) * 0.35, -0.35, 1) * mm * m, total);
  extend(points, false, clamp(0.35 + gaussian(rng) * 0.4, -0.35, 1.2) * mm * m, total);

  // A long line is often drawn in two goes, the second picking up a little
  // before the first stopped and not quite in line with it.
  if (total > 70 * mm && rng() < 0.5 * m) {
    const cut = Math.floor(points.length * (0.35 + rng() * 0.3));
    const overlap = Math.max(1, Math.round(points.length * 0.02));
    const nudge = gaussian(rng) * 0.18 * mm * m;
    const first = points.slice(0, cut + overlap);
    const second = points.slice(Math.max(0, cut - overlap)).map((p) => ({ x: p.x, y: p.y + nudge }));
    return [first, second];
  }
  return [points];
}

/** Lengthen (or shorten, when negative) one end of a line along its direction. */
function extend(points: { x: number; y: number }[], start: boolean, by: number, total: number): void {
  if (points.length < 2 || Math.abs(by) < 1e-3) return;
  const amount = Math.max(-total * 0.2, by);
  const i0 = start ? 0 : points.length - 1;
  const i1 = start ? Math.min(points.length - 1, 2) : Math.max(0, points.length - 3);
  let dx = points[i0].x - points[i1].x;
  let dy = points[i0].y - points[i1].y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  points[i0] = { x: points[i0].x + dx * amount, y: points[i0].y + dy * amount };
}

/**
 * Shade an area with quick parallel strokes, as a writer shades a bar rather
 * than filling it. The lines are clipped to the outline, run a hair past it
 * now and then, and are not all quite parallel.
 */
function hatching(pts: number[], style: SketchStyle, m: number, rng: Rng, degrees: number, gap: number): InkStroke[] {
  const { mm } = style;
  const angle = (degrees * Math.PI) / 180;
  const spacing = gap * (0.92 + rng() * 0.16);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Rotate the outline so the hatch lines are horizontal.
  const n = pts.length / 2;
  const rx: number[] = [];
  const ry: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    rx.push(x * cos + y * sin);
    ry.push(-x * sin + y * cos);
    minY = Math.min(minY, ry[i]);
    maxY = Math.max(maxY, ry[i]);
  }
  const back = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const out: InkStroke[] = [];
  for (let y = minY + spacing * (0.4 + rng() * 0.3); y < maxY; y += spacing * (0.9 + rng() * 0.2)) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = ry[i];
      const y1 = ry[j];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(rx[i] + ((y - y0) / (y1 - y0)) * (rx[j] - rx[i]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const inset = 0.25 * mm;
      let x0 = xs[k] + inset + gaussian(rng) * 0.15 * mm * m;
      let x1 = xs[k + 1] - inset + gaussian(rng) * 0.2 * mm * m;
      if (x1 - x0 < 0.8 * mm) continue;
      const tilt = gaussian(rng) * 0.25 * mm * m;
      if (rng() < 0.5) [x0, x1] = [x1, x0];
      const mid = (x0 + x1) / 2;
      out.push({
        points: [back(x0, y - tilt), back(mid, y + gaussian(rng) * 0.06 * mm), back(x1, y + tilt)],
        width: style.lineWidth * 0.85,
        opacity: 0.85,
        shade: gaussian(rng) * 0.15,
        taper: true,
      });
    }
  }
  return out;
}
