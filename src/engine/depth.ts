/**
 * Paper has depth.
 *
 * A pen does not only leave ink: it presses a groove into the sheet. Under
 * room light the walls of the groove catch the light on one side and fall
 * into shade on the other, and a ballpoint's ink lies thickest in the bottom
 * of it, so a line is darker along its middle and where it crosses another
 * than at its edges. On a sheet written on both sides the other side is
 * there too: its ink shows through, grey, blurred and broken up by the
 * fibres, stronger where the paper is thin; and its grooves stand up on this
 * side as soft ridges, mirrored.
 *
 * All of it comes from the two ink layers. Blurred, the alpha of a layer is
 * how deep the pen went at each point; the slope of that towards the light
 * says how bright the paper is there.
 */
import { canBlur, get2d, MM, scratchCanvas, type AnyCanvas, type CanvasFactory, type Ctx2D } from './paper';
import type { PenStyle } from './pen';
import { createTileNoise, hashInts, mulberry32 } from './random';

/** Spread of a pen's groove either side of the line, in millimetres. */
const GROOVE_MM = 0.12;
/** How far ink on the other side spreads in the fibre before it shows here. */
const THROUGH_MM = 0.3;
/** Size of the clouds in the paper, thinner and thicker, that let more or less through. */
const CLOUD_MM = 4;
/**
 * Size of the fibres. Ink comes through a sheet where the fibres let it, so
 * what shows is broken into specks rather than a smooth grey line.
 */
const FIBRE_MM = 0.16;
/** Side of the square of fibre worked out once and laid over the page, in pixels. */
const FIBRE_TILE = 256;

export interface Impression {
  /** The page with the paper on it and no ink yet. */
  paper: Ctx2D;
  width: number;
  height: number;
  /**
   * This side's ink, flat on a transparent layer, or null to leave the pen's
   * own groove out. Its ink is thinned in place where it lies shallow.
   */
  front: AnyCanvas | null;
  /** The other side's ink as it was written there; it is mirrored here. */
  back: AnyCanvas | null;
  pen: PenStyle;
  /** Colour of the ink, which tints what shows through. */
  ink: [number, number, number];
  /** Device pixels per layout unit. */
  scale: number;
  seed: number;
  pageIndex: number;
  createCanvas: CanvasFactory;
}

/**
 * The page on the other side of the same sheet: pages 1 and 2 are the front
 * and back of the first sheet, 3 and 4 of the second, and so on (counting
 * from 0 here, 0 and 1, 2 and 3).
 */
export function otherSide(pageIndex: number): number {
  return pageIndex ^ 1;
}

export function impress(im: Impression): void {
  const { paper, width: w, height: h, front, back, pen } = im;
  if (!front && !back) return;
  const perMm = MM * im.scale;
  const rng = mulberry32(hashInts(im.seed, im.pageIndex, 0xde97));
  // Room light falls from the upper left, give or take.
  const angle = Math.PI * (1.25 + (rng() - 0.5) * 0.3);
  const lx = Math.cos(angle);
  const ly = Math.sin(angle);

  const groove = front ? depthMap(front, im, GROOVE_MM * perMm, false, 0) : null;
  const through = back ? depthMap(back, im, THROUGH_MM * perMm, true, 1) : null;
  const grooveRows = groove ? inkedRows(groove, w, h) : null;
  const throughRows = through ? inkedRows(through, w, h) : null;
  // Only read on rows where the flags above say there is a map to read.
  const g = groove ?? new Float32Array(0);
  const b = through ?? new Float32Array(0);

  // Steps towards the light over which the slope of each surface is taken.
  const gd = Math.max(1, GROOVE_MM * perMm);
  const gx = Math.round(lx * gd);
  const gy = Math.round(ly * gd);
  const td = Math.max(1, THROUGH_MM * perMm * 0.7);
  const tx = Math.round(lx * td);
  const ty = Math.round(ly * td);

  const grooveRelief = 0.14 * pen.press;
  const ridgeRelief = 0.08 * pen.press;
  const ghost = 0.13 * pen.soak;
  // Ink seen through paper loses most of its colour to the fibre between.
  const [ir, ig, ib] = im.ink;
  const lum = (0.3 * ir + 0.59 * ig + 0.11 * ib) / 255;
  const takeR = 1 - (0.4 * ir) / 255 - 0.6 * lum;
  const takeG = 1 - (0.4 * ig) / 255 - 0.6 * lum;
  const takeB = 1 - (0.4 * ib) / 255 - 0.6 * lum;
  const cloudPx = CLOUD_MM * perMm;
  const clouds = createTileNoise(rng, Math.ceil(Math.max(w, h) / cloudPx) + 2);
  const fibre = fibreTile(Math.max(0.8, FIBRE_MM * perMm));
  // Each page lies on a different part of the fibre.
  const fx = Math.floor(rng() * FIBRE_TILE);
  const fy = Math.floor(rng() * FIBRE_TILE);

  const image = paper.getImageData(0, 0, w, h);
  const d = image.data;
  const lastX = w - 1;
  const lastY = h - 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const yA = clampInt(y + gy, lastY);
    const yB = clampInt(y - gy, lastY);
    const tA = clampInt(y + ty, lastY);
    const tB = clampInt(y - ty, lastY);
    // Most rows of a page are margin or the space between lines: nothing to do.
    const grooved = grooveRows !== null && (grooveRows[yA] | grooveRows[yB]) !== 0;
    const backed = throughRows !== null && (throughRows[y] | throughRows[tA] | throughRows[tB]) !== 0;
    if (!grooved && !backed) continue;
    const gyA = yA * w;
    const gyB = yB * w;
    const tyA = tA * w;
    const tyB = tB * w;
    const fibreRow = ((y + fy) % FIBRE_TILE) * FIBRE_TILE;
    let cloud = 1;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let light = 1;
      // A groove: its wall facing the light is lit, the one facing away in shade.
      if (grooved) light += grooveRelief * (g[gyA + clampInt(x + gx, lastX)] - g[gyB + clampInt(x - gx, lastX)]);
      let shown = 0;
      if (backed) {
        // A ridge is the other way about.
        light -= ridgeRelief * (b[tyA + clampInt(x + tx, lastX)] - b[tyB + clampInt(x - tx, lastX)]);
        const t = b[i];
        if (t > 0.002) {
          // The clouds are broad, so every fourth pixel is often enough to ask.
          if ((x & 3) === 0 || cloud === 1) cloud = 0.5 + 0.9 * clouds(x / cloudPx, y / cloudPx);
          shown = ghost * t * cloud * fibre[fibreRow + ((x + fx) % FIBRE_TILE)];
        }
      }
      if (light === 1 && shown === 0) continue;
      const o = i * 4;
      d[o] = d[o] * light * (1 - shown * takeR);
      d[o + 1] = d[o + 1] * light * (1 - shown * takeG);
      d[o + 2] = d[o + 2] * light * (1 - shown * takeB);
    }
  }
  paper.putImageData(image, 0, 0);

  // Ballpoint paste settles in the bottom of the groove; liquid ink floods
  // it evenly and dries darker at the edge instead.
  const shallow = 0.35 * pen.press * (1 - pen.edge);
  if (front && groove && grooveRows && shallow > 0.01) {
    const fctx = get2d(front);
    const inkImage = fctx.getImageData(0, 0, w, h);
    const fd = inkImage.data;
    for (let y = 0; y < h; y++) {
      if (grooveRows[y] === 0) continue;
      for (let i = y * w, end = i + w; i < end; i++) {
        const a = fd[i * 4 + 3];
        if (a === 0) continue;
        const depth = Math.min(1, groove[i] * 1.6);
        fd[i * 4 + 3] = a * (1 - shallow * (1 - depth));
      }
    }
    fctx.putImageData(inkImage, 0, 0);
  }
}

function clampInt(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/** Which rows of a map have anything in them (1) and which are empty (0). */
function inkedRows(map: Float32Array, w: number, h: number): Uint8Array {
  const rows = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    for (let i = y * w, end = i + w; i < end; i++) {
      if (map[i] > 0) {
        rows[y] = 1;
        break;
      }
    }
  }
  return rows;
}

/**
 * How deep the pen went at each point of an ink layer: its alpha, 0..1,
 * spread by `sigma` pixels and mirrored left to right if asked. The canvas
 * does the blurring where it can, which is many times faster.
 */
function depthMap(src: AnyCanvas, im: Impression, sigma: number, mirror: boolean, slot: number): Float32Array {
  const { width: w, height: h } = im;
  const n = w * h;
  const out = buffer(slot, n);
  const work = scratchCanvas(w, h, 'depth', im.createCanvas);
  const ctx = get2d(work);
  const gpu = canBlur(ctx);
  if (gpu && sigma >= 0.4) ctx.filter = `blur(${sigma.toFixed(2)}px)`;
  if (mirror) ctx.setTransform(-1, 0, 0, 1, w, 0);
  ctx.drawImage(src as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < n; i++) out[i] = data[i * 4 + 3] / 255;
  if (!gpu) blur(out, buffer(2, n), w, h, sigma);
  return out;
}

/** Two box blurs one after the other, which is close enough to a Gaussian of this spread. */
function blur(a: Float32Array, tmp: Float32Array, w: number, h: number, sigma: number): void {
  const r = Math.round(Math.sqrt(1.5 * sigma * sigma + 0.25) - 0.5);
  if (r < 1) return;
  for (let pass = 0; pass < 2; pass++) {
    boxRows(a, tmp, w, h, r);
    boxColumns(tmp, a, w, h, r);
  }
}

function boxRows(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x < r && x < w; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) sum += src[row + x + r];
      dst[row + x] = sum * norm;
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
}

/** The same down the columns, a row at a time so memory is read in order. */
function boxColumns(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const norm = 1 / (2 * r + 1);
  const sum = new Float64Array(w);
  for (let y = 0; y < r && y < h; y++) for (let x = 0; x < w; x++) sum[x] += src[y * w + x];
  for (let y = 0; y < h; y++) {
    if (y + r < h) {
      const add = (y + r) * w;
      for (let x = 0; x < w; x++) sum[x] += src[add + x];
    }
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = sum[x] * norm;
    if (y - r >= 0) {
      const sub = (y - r) * w;
      for (let x = 0; x < w; x++) sum[x] -= src[sub + x];
    }
  }
}

let fibreCache: { px: number; tile: Float32Array } | null = null;

/**
 * How much of the ink behind each point gets through the fibre, over a square
 * that repeats: mostly little, now and then a lot. Too fine to see repeat.
 */
function fibreTile(px: number): Float32Array {
  if (fibreCache?.px === px) return fibreCache.tile;
  const cells = Math.round(FIBRE_TILE / px);
  const noise = createTileNoise(mulberry32(0xf1b4e), cells);
  const tile = new Float32Array(FIBRE_TILE * FIBRE_TILE);
  for (let y = 0; y < FIBRE_TILE; y++) {
    for (let x = 0; x < FIBRE_TILE; x++) {
      const f = noise((x * cells) / FIBRE_TILE, (y * cells) / FIBRE_TILE);
      tile[y * FIBRE_TILE + x] = 0.2 + 2.2 * f * f * f;
    }
  }
  fibreCache = { px, tile };
  return tile;
}

const buffers: Float32Array[] = [];

/** A working buffer of n values, kept between pages. Its contents are whatever was left in it. */
function buffer(slot: number, n: number): Float32Array {
  let b = buffers[slot];
  if (!b || b.length !== n) {
    b = new Float32Array(n);
    buffers[slot] = b;
  }
  return b;
}

/** Release the working buffers. Worth calling after a high-resolution export. */
export function releaseDepth(): void {
  buffers.length = 0;
  fibreCache = null;
}
