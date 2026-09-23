import { drawPaper, get2d, MM, type AnyCanvas, type CanvasFactory, type Ctx2D } from './paper';
import { clamp, hashInts, mulberry32 } from './random';
import type { DocumentLayout, PenType, Settings } from './types';

interface PenStyle {
  /** Extra outline at full pressure, as a fraction of the font size. */
  strokeWeight: number;
  /** Ink bleed blur radius in millimetres. */
  bleed: number;
  bleedAlpha: number;
  alpha: number;
  /** Fraction of pencil strokes knocked out by paper tooth. */
  grain: number;
}

const PENS: Record<PenType, PenStyle> = {
  ballpoint: { strokeWeight: 0.012, bleed: 0.05, bleedAlpha: 0.25, alpha: 0.95, grain: 0 },
  gel: { strokeWeight: 0.024, bleed: 0.08, bleedAlpha: 0.35, alpha: 1, grain: 0 },
  fountain: { strokeWeight: 0.02, bleed: 0.14, bleedAlpha: 0.45, alpha: 0.92, grain: 0 },
  pencil: { strokeWeight: 0.004, bleed: 0.03, bleedAlpha: 0.2, alpha: 0.78, grain: 0.5 },
};

export interface RenderOptions {
  /** Device pixels per layout unit. 1 = 96 DPI, 3.125 = 300 DPI. */
  scale: number;
  /** CSS font-family list, e.g. `"Caveat", "Kalam"`. */
  fontStack: string;
  createCanvas: CanvasFactory;
}

let inkLayer: AnyCanvas | null = null;

/** Draw one page (paper + handwriting + optional scan look) onto `target`. */
export function renderPage(
  target: AnyCanvas,
  doc: DocumentLayout,
  pageIndex: number,
  s: Settings,
  opts: RenderOptions,
): void {
  const { scale, createCanvas } = opts;
  const geom = doc.geometry;
  const w = Math.max(1, Math.round(geom.width * scale));
  const h = Math.max(1, Math.round(geom.height * scale));
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;

  const ctx = get2d(target);
  drawPaper(ctx, geom, s, scale, pageIndex, createCanvas);

  const page = doc.pages[pageIndex];
  if (page && page.glyphs.length > 0) {
    if (!inkLayer || inkLayer.width !== w || inkLayer.height !== h) inkLayer = createCanvas(w, h);
    const ink = get2d(inkLayer);
    ink.setTransform(1, 0, 0, 1, 0, 0);
    ink.clearRect(0, 0, w, h);
    drawInk(ink, doc, pageIndex, s, opts);

    const pen = PENS[s.pen] ?? PENS.ballpoint;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    const bleedPx = pen.bleed * MM * scale;
    if (bleedPx >= 0.3 && supportsFilter(ctx)) {
      ctx.filter = `blur(${bleedPx.toFixed(2)}px)`;
      ctx.globalAlpha = pen.bleedAlpha;
      ctx.drawImage(inkLayer as CanvasImageSource, 0, 0);
      ctx.filter = 'none';
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(inkLayer as CanvasImageSource, 0, 0);
    ctx.restore();
  }

  if (s.scanEffect) applyScanLook(target, ctx, s, pageIndex, scale, createCanvas);
}

function drawInk(ctx: Ctx2D, doc: DocumentLayout, pageIndex: number, s: Settings, opts: RenderOptions): void {
  const pen = PENS[s.pen] ?? PENS.ballpoint;
  const palette = shadePalette(s.inkColor);
  const fontPx = doc.fontPx;
  const { scale } = opts;

  ctx.save();
  ctx.font = `${fontPx}px ${opts.fontStack}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.direction = 'ltr';
  let rtl = false;

  for (const g of doc.pages[pageIndex].glyphs) {
    if (Boolean(g.rtl) !== rtl) {
      rtl = !rtl;
      ctx.direction = rtl ? 'rtl' : 'ltr';
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(g.x, g.y);
    if (g.rotation !== 0) ctx.rotate(g.rotation);
    if (g.skew !== 0) ctx.transform(1, 0, -g.skew, 1, 0, 0);
    ctx.scale(g.scaleX, g.scaleY);

    const color = palette[Math.round(clamp(g.shade, -1, 1) * SHADE_STEPS) + SHADE_STEPS];
    ctx.globalAlpha = g.opacity * pen.alpha;
    ctx.fillStyle = color;
    const stroke = pen.strokeWeight * fontPx * (0.3 + g.pressure);
    if (stroke * scale > 0.15) {
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke;
      ctx.strokeText(g.text, 0, 0);
    }
    ctx.fillText(g.text, 0, 0);
  }
  ctx.restore();

  if (pen.grain > 0) {
    // Paper tooth: punch tiny holes in pencil strokes.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    const pattern = ctx.createPattern(noiseTile(s.seed + pageIndex, 160, pen.grain, opts.createCanvas) as CanvasImageSource, 'repeat');
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    ctx.restore();
  }
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
  const copy = createCanvas(w, h);
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
