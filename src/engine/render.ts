import { drawPaper, get2d, MM, type AnyCanvas, type CanvasFactory, type Ctx2D } from './paper';
import { clamp, hashInts, mulberry32 } from './random';
import type { DocumentLayout, InkStroke, PenType, PlacedGlyph, Settings } from './types';

interface PenStyle {
  /** Extra outline at full pressure, as a fraction of the font size. */
  strokeWeight: number;
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
}

const PENS: Record<PenType, PenStyle> = {
  ballpoint: { strokeWeight: 0.012, bleed: 0.05, bleedAlpha: 0.25, alpha: 0.95, grain: 0.05, nib: 0, nibAngle: 0, pooling: 0.5 },
  gel: { strokeWeight: 0.024, bleed: 0.08, bleedAlpha: 0.35, alpha: 1, grain: 0, nib: 0, nibAngle: 0, pooling: 0.7 },
  rollerball: { strokeWeight: 0.018, bleed: 0.11, bleedAlpha: 0.4, alpha: 0.97, grain: 0, nib: 0.02, nibAngle: 40, pooling: 0.9 },
  fountain: { strokeWeight: 0.016, bleed: 0.15, bleedAlpha: 0.45, alpha: 0.93, grain: 0, nib: 0.055, nibAngle: 42, pooling: 1.1 },
  calligraphy: { strokeWeight: 0.008, bleed: 0.12, bleedAlpha: 0.4, alpha: 0.96, grain: 0, nib: 0.13, nibAngle: 40, pooling: 1.3 },
  felt: { strokeWeight: 0.048, bleed: 0.18, bleedAlpha: 0.5, alpha: 1, grain: 0.02, nib: 0, nibAngle: 0, pooling: 0.4 },
  pencil: { strokeWeight: 0.004, bleed: 0.03, bleedAlpha: 0.2, alpha: 0.78, grain: 0.5, nib: 0.018, nibAngle: 55, pooling: 0 },
};

/**
 * Copies of a glyph laid side by side to make up the width of a nib. The
 * number follows the resolution, so the copies always land under a pixel
 * apart and never show as banding, however wide the nib or large the page.
 */
const NIB_SPACING_PX = 0.7;
const NIB_STEPS_MAX = 16;

export interface RenderOptions {
  /** Device pixels per layout unit. 1 = 96 DPI, 3.125 = 300 DPI. */
  scale: number;
  /** CSS font-family list, e.g. `"Caveat", "Kalam"`. */
  fontStack: string;
  createCanvas: CanvasFactory;
}

const layerPool = new Map<string, AnyCanvas>();

function layer(w: number, h: number, key: string, createCanvas: CanvasFactory): AnyCanvas {
  const id = `${key}:${w}x${h}`;
  let canvas = layerPool.get(id);
  if (!canvas) {
    if (layerPool.size > 4) layerPool.clear();
    canvas = createCanvas(w, h);
    layerPool.set(id, canvas);
  }
  const ctx = get2d(canvas);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  return canvas;
}

/** Release the cached layers. Worth calling after a high-resolution export. */
export function releaseLayers(): void {
  layerPool.clear();
}

/** Draw one page (paper + handwriting + optional finish) onto `target`. */
export function renderPage(
  target: AnyCanvas,
  doc: DocumentLayout,
  pageIndex: number,
  s: Settings,
  opts: RenderOptions,
): void {
  const { scale, createCanvas } = opts;
  const geom = doc.geometryOf(pageIndex);
  const w = Math.max(1, Math.round(geom.width * scale));
  const h = Math.max(1, Math.round(geom.height * scale));
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;

  const ctx = get2d(target);
  ctx.filter = 'none';
  drawPaper(ctx, geom, s, scale, pageIndex, createCanvas);

  // Ink from the other side of the sheet, showing faintly through the paper.
  const back = s.features.showThrough ? doc.pages[pageIndex + 1] : undefined;
  if (back && (back.glyphs.length > 0 || back.strokes.length > 0)) {
    const bleedCanvas = layer(w, h, 'back', createCanvas);
    const bleed = get2d(bleedCanvas);
    drawInk(bleed, doc, pageIndex + 1, s, opts, true);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.07;
    if (supportsFilter(ctx)) ctx.filter = `blur(${Math.max(0.4, 0.12 * MM * scale).toFixed(2)}px)`;
    // The back of the sheet is a mirror image.
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(bleedCanvas as CanvasImageSource, 0, 0);
    ctx.filter = 'none';
    ctx.restore();
  }

  const page = doc.pages[pageIndex];
  if (page && (page.glyphs.length > 0 || page.strokes.length > 0)) {
    const inkCanvas = layer(w, h, 'ink', createCanvas);
    const ink = get2d(inkCanvas);
    drawInk(ink, doc, pageIndex, s, opts, false);

    const pen = PENS[s.pen] ?? PENS.ballpoint;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    const bleedPx = pen.bleed * MM * scale;
    if (bleedPx >= 0.3 && supportsFilter(ctx)) {
      ctx.filter = `blur(${bleedPx.toFixed(2)}px)`;
      ctx.globalAlpha = pen.bleedAlpha;
      ctx.drawImage(inkCanvas as CanvasImageSource, 0, 0);
      ctx.filter = 'none';
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(inkCanvas as CanvasImageSource, 0, 0);
    ctx.restore();
  }

  if (s.finish === 'scan') applyScanLook(target, ctx, s, pageIndex, scale, createCanvas);
  else if (s.finish === 'photo') applyPhotoLook(target, ctx, s, pageIndex, scale, createCanvas);
}

/** Paint the handwriting of one page as flat ink on a transparent layer. */
function drawInk(
  ctx: Ctx2D,
  doc: DocumentLayout,
  pageIndex: number,
  s: Settings,
  opts: RenderOptions,
  plain: boolean,
): void {
  const pen = PENS[s.pen] ?? PENS.ballpoint;
  const palette = shadePalette(s.inkColor);
  const fontPx = doc.fontPx;
  const { scale } = opts;
  const page = doc.pages[pageIndex];
  const weight = clamp(s.inkWeight, 0, 3);

  // A nib is a short line, not a point: draw the glyph once per step across it.
  const nibWidth = plain ? 0 : pen.nib * fontPx;
  const steps = nibWidth > 0.01 ? clamp(Math.round((nibWidth * scale) / NIB_SPACING_PX) + 1, 3, NIB_STEPS_MAX) : 1;
  const nx = Math.cos(pen.nibAngle * (Math.PI / 180));
  const ny = Math.sin(pen.nibAngle * (Math.PI / 180));

  ctx.save();
  ctx.font = `${fontPx}px ${opts.fontStack}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.direction = 'ltr';
  let rtl = false;

  for (const g of page.glyphs) {
    if (Boolean(g.rtl) !== rtl) {
      rtl = !rtl;
      ctx.direction = rtl ? 'rtl' : 'ltr';
    }
    const color = palette[Math.round(clamp(g.shade, -1, 1) * SHADE_STEPS) + SHADE_STEPS];
    // Each pass adds ink on top of the last, so ask each for less than the total.
    const alpha = g.opacity * pen.alpha;
    ctx.globalAlpha = steps === 1 ? alpha : 1 - Math.pow(1 - alpha, 1 / steps);
    ctx.fillStyle = color;
    const stroke = pen.strokeWeight * weight * fontPx * (0.3 + g.pressure);

    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : (i / (steps - 1) - 0.5) * nibWidth;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.translate(g.x + nx * t, g.y + ny * t);
      if (g.rotation !== 0) ctx.rotate(g.rotation);
      if (g.skew !== 0) ctx.transform(1, 0, -g.skew, 1, 0, 0);
      ctx.scale(g.scaleX, g.scaleY);
      if (stroke * scale > 0.15) {
        ctx.strokeStyle = color;
        ctx.lineWidth = stroke;
        ctx.strokeText(g.text, 0, 0);
      }
      ctx.fillText(g.text, 0, 0);
    }

    if (g.blot !== undefined && g.blot > 0 && pen.pooling > 0 && !plain) {
      drawPool(ctx, g, color, fontPx, pen.pooling, scale);
    }
  }
  ctx.restore();

  if (page.strokes.length > 0) drawStrokes(ctx, page.strokes, palette, scale, weight);

  const grain = plain ? 0 : pen.grain;
  if (grain > 0) {
    // Paper tooth: punch tiny holes in the stroke.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    const tile = noiseTile(s.seed + pageIndex, 160, grain, opts.createCanvas);
    const pattern = ctx.createPattern(tile as CanvasImageSource, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    ctx.restore();
  }
}

/** Ink pooled where the pen was set down at the start of a word. */
function drawPool(ctx: Ctx2D, g: PlacedGlyph, color: string, fontPx: number, pooling: number, scale: number): void {
  const r = fontPx * 0.035 * pooling * (0.5 + g.blot!);
  if (r * scale < 0.4) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 0.5 * g.opacity;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(g.x + fontPx * 0.04, g.y - fontPx * 0.12, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Underlines, strike-outs, carets, bullets and stray dots of ink. */
function drawStrokes(ctx: Ctx2D, strokes: InkStroke[], palette: string[], scale: number, weight: number): void {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    const color = palette[Math.round(clamp(stroke.shade, -1, 1) * SHADE_STEPS) + SHADE_STEPS];
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    const lw = Math.max(0.2, stroke.width * weight);
    if (stroke.points.length === 1) {
      const p = stroke.points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, lw, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineCap = stroke.taper ? 'round' : 'butt';
    ctx.lineWidth = lw;
    ctx.beginPath();
    const pts = stroke.points;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

const SHADE_STEPS = 8;

/** Ink colours from slightly lighter (-1) to slightly darker (+1) than the base. */
function shadePalette(hex: string): string[] {
  const [r, g, b] = parseHex(hex);
  const out: string[] = [];
  for (let i = -SHADE_STEPS; i <= SHADE_STEPS; i++) {
    const t = i / SHADE_STEPS;
    const mix = (c: number) => (t < 0 ? c + (255 - c) * -t * 0.28 : c * (1 - t * 0.3));
    out.push(`rgb(${Math.round(mix(r))}, ${Math.round(mix(g))}, ${Math.round(mix(b))})`);
  }
  return out;
}

export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : 0x1a3a8a;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let filterSupport: boolean | undefined;
function supportsFilter(ctx: Ctx2D): boolean {
  if (filterSupport === undefined) {
    const c = ctx as CanvasRenderingContext2D;
    if (typeof c.filter !== 'string') {
      filterSupport = false;
    } else {
      const before = c.filter;
      c.filter = 'blur(1px)';
      filterSupport = c.filter === 'blur(1px)';
      c.filter = before;
    }
  }
  return filterSupport;
}

const noiseCache = new Map<string, AnyCanvas>();

/** Tile of black specks whose alpha averages `density`. */
function noiseTile(seed: number, size: number, density: number, createCanvas: CanvasFactory): AnyCanvas {
  const key = `${seed}:${size}:${density}`;
  const cached = noiseCache.get(key);
  if (cached) return cached;
  if (noiseCache.size > 16) noiseCache.clear();
  const canvas = createCanvas(size, size);
  const ctx = get2d(canvas);
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(hashInts(seed, 0x0415e));
  for (let i = 0; i < size * size; i++) {
    const v = rng();
    img.data[i * 4 + 3] = Math.round(Math.pow(v, 3) * density * 2 * 255);
  }
  ctx.putImageData(img, 0, 0);
  noiseCache.set(key, canvas);
  return canvas;
}

/** A flatbed-scan look: a slightly crooked page, uneven light and sensor noise. */
function applyScanLook(
  target: AnyCanvas,
  ctx: Ctx2D,
  s: Settings,
  pageIndex: number,
  scale: number,
  createCanvas: CanvasFactory,
): void {
  const w = target.width;
  const h = target.height;
  const copy = layer(w, h, 'finish', createCanvas);
  get2d(copy).drawImage(target as CanvasImageSource, 0, 0);

  const r = mulberry32(hashInts(s.seed, pageIndex, 0x5ca9));
  const angle = (r() - 0.5) * 0.9 * (Math.PI / 180);
  const dx = (r() - 0.5) * 1.5 * MM * scale;
  const dy = (r() - 0.5) * 1.5 * MM * scale;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ecece8';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2 + dx, h / 2 + dy);
  ctx.rotate(angle);
  ctx.drawImage(copy as CanvasImageSource, -w / 2, -h / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Uneven lamp light across the page.
  const a = r() * Math.PI * 2;
  const cx = w / 2;
  const cy = h / 2;
  const len = Math.hypot(w, h) / 2;
  const light = ctx.createLinearGradient(cx - Math.cos(a) * len, cy - Math.sin(a) * len, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
  light.addColorStop(0, 'rgba(255,255,255,0)');
  light.addColorStop(1, 'rgba(60,55,50,0.10)');
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);

  const vignette = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.35, cx, cy, len);
  vignette.addColorStop(0, 'rgba(255,255,255,0)');
  vignette.addColorStop(1, 'rgba(90,90,90,0.12)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';
  const pattern = ctx.createPattern(noiseTile(s.seed + 99, 128, 0.12, createCanvas) as CanvasImageSource, 'repeat');
  if (pattern) {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/**
 * A photo of the page on a desk: the sheet is not quite square to the camera,
 * so it keystones; the light falls off to one side and the paper casts a soft
 * shadow. The warp is built from horizontal slices, which is exact for a
 * trapezoid and close enough for the small angles a hand-held phone makes.
 */
function applyPhotoLook(
  target: AnyCanvas,
  ctx: Ctx2D,
  s: Settings,
  pageIndex: number,
  scale: number,
  createCanvas: CanvasFactory,
): void {
  const w = target.width;
  const h = target.height;
  const copy = layer(w, h, 'finish', createCanvas);
  get2d(copy).drawImage(target as CanvasImageSource, 0, 0);

  const r = mulberry32(hashInts(s.seed, pageIndex, 0x9401));
  // Keystone: the far edge of the sheet is a little narrower than the near one.
  const taper = (0.012 + r() * 0.022) * (r() < 0.5 ? -1 : 1);
  const tilt = (r() - 0.5) * 1.6 * (Math.PI / 180);
  const inset = 0.022 + r() * 0.02;
  const shadowSide = r() < 0.5 ? -1 : 1;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // The surface the page is lying on.
  const desk = ctx.createLinearGradient(0, 0, w, h);
  desk.addColorStop(0, '#d7d2c9');
  desk.addColorStop(1, '#bdb6aa');
  ctx.fillStyle = desk;
  ctx.fillRect(0, 0, w, h);
  const deskNoise = ctx.createPattern(noiseTile(s.seed + 7, 128, 0.16, createCanvas) as CanvasImageSource, 'repeat');
  if (deskNoise) {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = deskNoise;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  const pageW = w * (1 - inset * 2);
  const pageH = h * (1 - inset * 2);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(tilt);

  // Soft contact shadow under the sheet.
  ctx.save();
  ctx.globalAlpha = 0.5;
  if (supportsFilter(ctx)) ctx.filter = `blur(${Math.max(2, 0.9 * MM * scale).toFixed(1)}px)`;
  ctx.fillStyle = 'rgba(40,36,30,0.55)';
  ctx.fillRect(-pageW / 2 + shadowSide * pageW * 0.012, -pageH / 2 + pageH * 0.012, pageW, pageH);
  ctx.filter = 'none';
  ctx.restore();

  // Slice the page into rows; each row is scaled to its share of the keystone.
  const rows = Math.max(24, Math.min(240, Math.round(pageH / 6)));
  for (let i = 0; i < rows; i++) {
    const t0 = i / rows;
    const t1 = (i + 1) / rows;
    const sy = t0 * h;
    const sh = (t1 - t0) * h + 1;
    const k0 = 1 + taper * (t0 - 0.5) * 2;
    const dw = pageW * k0;
    const dx = -dw / 2;
    const dy = -pageH / 2 + t0 * pageH;
    const dh = (t1 - t0) * pageH + 1;
    ctx.drawImage(copy as CanvasImageSource, 0, sy, w, sh, dx, dy, dw, dh);
  }

  // Light falling across the sheet, and a little shading where it curls.
  const light = ctx.createLinearGradient(-pageW / 2, -pageH / 2, pageW / 2, pageH / 2);
  light.addColorStop(0, 'rgba(255,252,240,0.10)');
  light.addColorStop(0.55, 'rgba(255,255,255,0)');
  light.addColorStop(1, 'rgba(45,40,35,0.16)');
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = light;
  ctx.fillRect(-pageW / 2, -pageH / 2, pageW, pageH);
  ctx.restore();

  // Camera grain and a gentle vignette over the whole frame.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 1.7);
  vignette.addColorStop(0, 'rgba(255,255,255,0)');
  vignette.addColorStop(1, 'rgba(30,28,25,0.22)');
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  const grain = ctx.createPattern(noiseTile(s.seed + 31, 128, 0.1, createCanvas) as CanvasImageSource, 'repeat');
  if (grain) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalAlpha = 1;
}
