/**
 * How the finished page reached the reader: laid on a flatbed scanner,
 * scanned with a phone app, or photographed on a desk.
 *
 * A page rendered flat is too perfect in ways a real page never is. Paper
 * does not lie flat — it bows, so the ruled lines curve a little. Light is
 * never even: one side is brighter, the hand holding the phone casts a soft
 * shadow, the binding edge falls into shade. And every capture leaves its own
 * signature: a scanner's grey cast and slight blur, a scanning app's
 * whitened paper and punched-up ink, a camera's warm light and grain.
 *
 * Each finish starts from the flat page and works on it as pixels, so it is
 * the same at any resolution and adds nothing to the layout.
 */
import { canBlur, get2d, MM, scratchCanvas, type AnyCanvas, type CanvasFactory, type Ctx2D } from './paper';
import { clamp, hashInts, mulberry32, type Rng } from './random';
import type { FinishLook } from './types';

interface FinishContext {
  target: AnyCanvas;
  ctx: Ctx2D;
  seed: number;
  pageIndex: number;
  /** Device pixels per layout unit. */
  scale: number;
  createCanvas: CanvasFactory;
  /** Which edge the binding is on, where paper lifts and falls into shade. */
  bindingSide: 'left' | 'right';
}

export function applyFinish(kind: FinishLook, fc: FinishContext): void {
  if (kind === 'scan') flatbed(fc);
  else if (kind === 'phone') phoneScan(fc);
  else if (kind === 'photo') photo(fc);
}

/** A copy of the page as it stands, to draw back bent and lit. */
function snapshot(fc: FinishContext): AnyCanvas {
  const { target, createCanvas } = fc;
  const copy = scratchCanvas(target.width, target.height, 'finish', createCanvas);
  get2d(copy).drawImage(target as CanvasImageSource, 0, 0);
  return copy;
}

/**
 * Draw the page back bowed: it is cut into narrow upright strips and each is
 * lifted by a smooth amount, so a ruled line comes out as a gentle curve. A
 * little twist as well — one end lifted more than the other — as a sheet
 * held flat by nothing but its own weight does.
 */
function drawBowed(ctx: Ctx2D, page: AnyCanvas, dx: number, dy: number, dw: number, dh: number, bow: number, twist: number): void {
  const w = page.width;
  const h = page.height;
  const strips = Math.max(40, Math.min(260, Math.round(w / 7)));
  for (let i = 0; i < strips; i++) {
    const u0 = i / strips;
    const u1 = (i + 1) / strips;
    const u = (u0 + u1) / 2;
    const c = u * 2 - 1;
    const lift = bow * (1 - c * c) + twist * c;
    const sx = u0 * w;
    const sw = (u1 - u0) * w + 1;
    ctx.drawImage(page as CanvasImageSource, sx, 0, sw, h, dx + u0 * dw, dy + lift, (u1 - u0) * dw + 1, dh);
  }
}

/** Run a function over every pixel, in place. It gets and returns 0..255 channels. */
function eachPixel(ctx: Ctx2D, w: number, h: number, fn: (x: number, y: number, rgb: number[]) => void): void {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  const rgb = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgb[0] = d[i];
      rgb[1] = d[i + 1];
      rgb[2] = d[i + 2];
      fn(x, y, rgb);
      d[i] = rgb[0];
      d[i + 1] = rgb[1];
      d[i + 2] = rgb[2];
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** A smooth pool of shadow, darkest at (cx, cy) and gone by `radius`. */
function shadowAt(x: number, y: number, cx: number, cy: number, radiusX: number, radiusY: number): number {
  const dx = (x - cx) / radiusX;
  const dy = (y - cy) / radiusY;
  const d = dx * dx + dy * dy;
  return d >= 1 ? 0 : (1 - d) * (1 - d);
}

/** Cheap per-pixel noise from a hash, for sensor grain. */
function grain(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/**
 * A flatbed scan: the page sits a little crooked on the glass, the lid's grey
 * shows along one edge, light falls off towards the edge the binding lifted,
 * and the scanner leaves a faint grey cast, a touch of softness and noise.
 */
function flatbed(fc: FinishContext): void {
  const { target, ctx, seed, pageIndex, scale } = fc;
  const w = target.width;
  const h = target.height;
  const r = mulberry32(hashInts(seed, pageIndex, 0x5ca9));
  const copy = snapshot(fc);
  const angle = (r() - 0.5) * 0.9 * (Math.PI / 180);
  const dx = (r() - 0.5) * 1.6 * MM * scale;
  const dy = (r() - 0.5) * 1.6 * MM * scale;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#dcdcd8';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2 + dx, h / 2 + dy);
  ctx.rotate(angle);
  if (canBlur(ctx)) ctx.filter = `blur(${Math.max(0.25, 0.035 * MM * scale).toFixed(2)}px)`;
  drawBowed(ctx, copy, -w / 2, -h / 2, w, h, 0, 0);
  ctx.restore();

  const lift = fc.bindingSide === 'left' ? 0 : w;
  const edge = w * 0.06;
  const tilt = (r() - 0.5) * 0.06;
  const noiseSeed = hashInts(seed, pageIndex, 0x5c4);
  eachPixel(ctx, w, h, (x, y, c) => {
    // Paper lifted off the glass near the binding goes grey.
    const nearBinding = Math.max(0, 1 - Math.abs(x - lift) / edge);
    const light = 0.965 - nearBinding * nearBinding * 0.2 + tilt * (y / h - 0.5);
    const n = grain(x, y, noiseSeed) * 3.5;
    for (let k = 0; k < 3; k++) c[k] = clamp(c[k] * light + 3 + n, 0, 255);
    // A scanner's slight cool-grey cast.
    c[2] = Math.min(255, c[2] + 2);
  });
}

/**
 * A page scanned with a phone app — what most homework is handed in as. The
 * app finds the page and straightens it, but not perfectly: the sheet still
 * bows, a sliver of desk shows at an edge, and the shadow of the phone lies
 * across one corner. Then it "enhances": the paper is pushed to white, the
 * ink to deep and saturated, and the ruling fades.
 */
function phoneScan(fc: FinishContext): void {
  const { target, ctx, seed, pageIndex, scale } = fc;
  const w = target.width;
  const h = target.height;
  const r = mulberry32(hashInts(seed, pageIndex, 0xa99));
  const copy = snapshot(fc);

  // The app's crop is never exact: the page is a hair too big or too small.
  const grow = 1 + (r() * 0.012 - 0.004);
  const angle = (r() - 0.5) * 0.7 * (Math.PI / 180);
  const offX = (r() - 0.5) * 0.008 * w;
  const offY = (r() - 0.5) * 0.008 * h;
  const bow = (0.5 + r() * 1.1) * MM * scale * (r() < 0.5 ? -1 : 1);
  const twist = (r() - 0.5) * 0.9 * MM * scale;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#5c5750';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2 + offX, h / 2 + offY);
  ctx.rotate(angle);
  drawBowed(ctx, copy, (-w / 2) * grow, (-h / 2) * grow, w * grow, h * grow, bow, twist);
  ctx.restore();

  const light = lighting(r, w, h, fc.bindingSide, 0.09, 0.16);
  const noiseSeed = hashInts(seed, pageIndex, 0xa9a);
  // The enhancement curve: the paper (after the shadows) goes to white, the
  // darkest ink to near black, and what lies between is stretched.
  const low = 0.1 * 255;
  const high = 0.86 * 255;
  eachPixel(ctx, w, h, (x, y, c) => {
    const l = light(x, y);
    const n = grain(x, y, noiseSeed) * 3;
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const v = clamp((c[k] * l - low) / (high - low), 0, 1);
      c[k] = Math.pow(v, 1.18) * 255;
      sum += c[k];
    }
    // Apps boost colour, which is what makes blue ink look so blue.
    const grey = sum / 3;
    for (let k = 0; k < 3; k++) c[k] = clamp(grey + (c[k] - grey) * 1.2 + n, 0, 255);
  });
}

/**
 * A photo of the page on a desk: the sheet is not square to the camera, so it
 * keystones; it bows; warm room light falls across it from one side; the hand
 * holding the phone shades a corner; and the camera adds grain, a little
 * softness and a vignette.
 */
function photo(fc: FinishContext): void {
  const { target, ctx, seed, pageIndex, scale, createCanvas } = fc;
  const w = target.width;
  const h = target.height;
  const r = mulberry32(hashInts(seed, pageIndex, 0x9401));
  const copy = snapshot(fc);

  // First bow the page on a scratch sheet, then keystone it onto the desk.
  const bowed = scratchCanvas(w, h, 'bowed', createCanvas);
  const bctx = get2d(bowed);
  const bow = (0.8 + r() * 1.6) * MM * scale * (r() < 0.5 ? -1 : 1);
  drawBowed(bctx, copy, 0, 0, w, h, bow, (r() - 0.5) * 1.2 * MM * scale);

  const taper = (0.015 + r() * 0.025) * (r() < 0.5 ? -1 : 1);
  const tilt = (r() - 0.5) * 2.4 * (Math.PI / 180);
  const inset = 0.035 + r() * 0.025;
  const shadowSide = r() < 0.5 ? -1 : 1;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  // The desk: warm wood-brown or a grey table.
  const wood = r() < 0.6;
  const desk = ctx.createLinearGradient(0, 0, w, h);
  desk.addColorStop(0, wood ? '#a8805a' : '#bdb8ae');
  desk.addColorStop(1, wood ? '#7d5a3c' : '#9a958b');
  ctx.fillStyle = desk;
  ctx.fillRect(0, 0, w, h);
  if (wood) woodGrain(ctx, w, h, r);

  const pageW = w * (1 - inset * 2);
  const pageH = h * (1 - inset * 2);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(tilt);

  // Soft contact shadow under the sheet.
  ctx.save();
  ctx.globalAlpha = 0.45;
  if (canBlur(ctx)) ctx.filter = `blur(${Math.max(2, 1.2 * MM * scale).toFixed(1)}px)`;
  ctx.fillStyle = 'rgba(30,24,18,0.7)';
  ctx.fillRect(-pageW / 2 + shadowSide * pageW * 0.01, -pageH / 2 + pageH * 0.012, pageW, pageH);
  ctx.restore();

  // Keystone: each row of the page is scaled to its share of the taper.
  if (canBlur(ctx)) ctx.filter = `blur(${Math.max(0.3, 0.04 * MM * scale).toFixed(2)}px)`;
  const rows = Math.max(24, Math.min(260, Math.round(pageH / 6)));
  for (let i = 0; i < rows; i++) {
    const t0 = i / rows;
    const t1 = (i + 1) / rows;
    const k0 = 1 + taper * (t0 - 0.5) * 2;
    const dw = pageW * k0;
    ctx.drawImage(bowed as CanvasImageSource, 0, t0 * h, w, (t1 - t0) * h + 1, -dw / 2, -pageH / 2 + t0 * pageH, dw, (t1 - t0) * pageH + 1);
  }
  ctx.restore();

  const light = lighting(r, w, h, fc.bindingSide, 0.22, 0.3);
  const warm = [1, 0.955, 0.86];
  const noiseSeed = hashInts(seed, pageIndex, 0x9402);
  const cx = w / 2;
  const cy = h / 2;
  const reach = Math.hypot(cx, cy);
  eachPixel(ctx, w, h, (x, y, c) => {
    const vignette = 1 - 0.22 * Math.pow(Math.hypot(x - cx, y - cy) / reach, 2.2);
    const l = light(x, y) * vignette;
    const n = grain(x, y, noiseSeed) * 7;
    for (let k = 0; k < 3; k++) c[k] = clamp(c[k] * l * warm[k] * 1.02 + n, 0, 255);
  });
}

/**
 * The light across a page: brighter on one side than the other, a soft
 * shadow of the phone or hand across one corner, and shade along the binding
 * where the paper curls up. Returns a multiplier for each pixel.
 */
function lighting(r: Rng, w: number, h: number, binding: 'left' | 'right', gradient: number, shadow: number): (x: number, y: number) => number {
  const angle = r() * Math.PI * 2;
  const gx = Math.cos(angle);
  const gy = Math.sin(angle);
  const span = Math.abs(gx) * w + Math.abs(gy) * h;
  const g = gradient * (0.6 + r() * 0.4);
  // The shadow comes in from one corner, long and soft.
  const corner = Math.floor(r() * 4);
  const sx = corner % 2 === 0 ? -w * 0.08 : w * 1.08;
  const sy = corner < 2 ? -h * 0.06 : h * 1.06;
  const srx = w * (0.35 + r() * 0.25);
  const sry = h * (0.25 + r() * 0.2);
  const s = shadow * (0.5 + r() * 0.5);
  const lift = binding === 'left' ? 0 : w;
  const edge = w * 0.05;
  return (x, y) => {
    const along = ((x - w / 2) * gx + (y - h / 2) * gy) / span + 0.5;
    const nearBinding = Math.max(0, 1 - Math.abs(x - lift) / edge);
    return 1 - g * along - s * shadowAt(x, y, sx, sy, srx, sry) - nearBinding * nearBinding * 0.12;
  };
}

/** Faint streaks of grain for a wooden desk. */
function woodGrain(ctx: Ctx2D, w: number, h: number, r: Rng): void {
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(1, w / 900);
  for (let i = 0; i < 90; i++) {
    const y0 = r() * h;
    const amp = h * (0.004 + r() * 0.01);
    ctx.strokeStyle = r() < 0.5 ? '#5b3d25' : '#c9a27b';
    ctx.beginPath();
    for (let x = 0; x <= w; x += w / 24) {
      const y = y0 + Math.sin(x / (w * 0.13) + i) * amp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
