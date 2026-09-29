import { applyFinish, releaseFinishes } from './finish';
import { drawPaper, get2d, MM, type AnyCanvas, type CanvasFactory, type Ctx2D } from './paper';
import { penFor, smoothSamples, tracePenStroke, type PenStyle } from './pen';
import { clamp, hashInts, mulberry32 } from './random';
import { createWarp, forEachPoint, traceOutline, warpStroke, type GlyphShapes, type Outline, type StrokeGlyph } from './shapes';
import type { DocumentLayout, InkStroke, PlacedGlyph, PlacedImage, Settings } from './types';

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
  /** The picture for a placed diagram, or null if it is not to hand. */
  images?: (id: string) => CanvasImageSource | null;
  /**
   * Letter outlines and stroke-drawn letters. Without them every letter is
   * drawn by the browser from the font, identical each time.
   */
  shapes?: GlyphShapes;
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
  releaseFinishes();
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

  const page0 = doc.pages[pageIndex];
  if (s.diagrams && page0 && page0.images.length > 0) {
    // Photographs are always stuck on; drawings only when asked to be.
    const stuck = s.diagramStyle === 'pasted' ? page0.images : page0.images.filter((image) => image.photo);
    if (stuck.length > 0) drawPastedImages(ctx, stuck, opts);
  }

  // Ink from the other side of the sheet, showing faintly through the paper.
  const back = s.features.showThrough ? doc.pages[pageIndex + 1] : undefined;
  if (back && (back.glyphs.length > 0 || back.strokes.length > 0 || back.images.length > 0)) {
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
  if (page && (page.glyphs.length > 0 || page.strokes.length > 0 || page.images.length > 0)) {
    const inkCanvas = layer(w, h, 'ink', createCanvas);
    const ink = get2d(inkCanvas);
    drawInk(ink, doc, pageIndex, s, opts, false);

    const pen = penFor(s.pen);
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

  if (s.finish !== 'none') {
    applyFinish(s.finish, { target, ctx, seed: s.seed, pageIndex, scale, createCanvas, bindingSide: geom.bindingSide });
  }
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
  const pen = penFor(s.pen);
  const palette = shadePalette(s.inkColor);
  const fontPx = doc.fontPx;
  const { scale } = opts;
  const page = doc.pages[pageIndex];
  const weight = clamp(s.inkWeight, 0, 3);
  const shapes = opts.shapes;

  // A nib is a short line, not a point: draw the glyph once per step across it.
  const nibWidth = plain ? 0 : pen.nib * fontPx;
  const steps = nibWidth > 0.01 ? clamp(Math.round((nibWidth * scale) / NIB_SPACING_PX) + 1, 3, NIB_STEPS_MAX) : 1;
  const nx = Math.cos(pen.nibAngle * (Math.PI / 180));
  const ny = Math.sin(pen.nibAngle * (Math.PI / 180));

  if (s.diagrams && s.diagramStyle === 'sketch' && page.images.some((image) => !image.photo)) {
    drawSketchedImages(ctx, page.images.filter((image) => !image.photo), s, opts);
  }

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
    const alpha = g.opacity * pen.alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    // A letter from the writer's own hand is a set of pen strokes.
    const written = !g.rtl && shapes?.strokeGlyph ? shapes.strokeGlyph(g.text, g.variant ?? 0) : null;
    if (written) {
      ctx.globalAlpha = alpha;
      drawStrokeGlyph(ctx, g, written, shapes!, pen, fontPx, scale, weight, plain, s.seed);
      continue;
    }

    const outline = !g.rtl && shapes ? shapes.outline(g.text) : null;
    const warp =
      outline && g.warp !== undefined && g.warp > 0
        ? createWarp({
            amount: g.warp,
            handSeed: s.seed,
            unit: g.text,
            variant: g.variant ?? 0,
            instanceSeed: g.seed ?? 0,
            advance: inkWidth(outline),
            xHeight: shapes!.xHeight,
            pinEnds: shapes!.connected,
          })
        : null;

    // Each pass adds ink on top of the last, so ask each for less than the total.
    ctx.globalAlpha = steps === 1 ? alpha : 1 - Math.pow(1 - alpha, 1 / steps);
    const stroke = pen.strokeWeight * weight * fontPx * (0.3 + g.pressure);
    const outlined = stroke * scale > 0.15;
    ctx.lineWidth = stroke;

    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : (i / (steps - 1) - 0.5) * nibWidth;
      placeGlyph(ctx, g, scale, g.x + nx * t, g.y + ny * t);
      if (outline) {
        ctx.beginPath();
        traceOutline(ctx, outline, fontPx, warp);
        ctx.fill();
        if (outlined) ctx.stroke();
      } else {
        if (outlined) ctx.strokeText(g.text, 0, 0);
        ctx.fillText(g.text, 0, 0);
      }
    }

    // Gel and fountain ink dries darker along the edge of the stroke.
    if (outline && pen.edge > 0 && !plain) {
      placeGlyph(ctx, g, scale, g.x, g.y);
      ctx.globalAlpha = alpha * pen.edge * 0.55;
      ctx.strokeStyle = palette[Math.min(palette.length - 1, Math.round(clamp(g.shade + 0.7, -1, 1) * SHADE_STEPS) + SHADE_STEPS)];
      ctx.lineWidth = fontPx * 0.011;
      ctx.beginPath();
      traceOutline(ctx, outline, fontPx, warp);
      ctx.stroke();
    }

    if (g.blot !== undefined && g.blot > 0 && pen.pooling > 0 && !plain) {
      drawPool(ctx, g, color, fontPx, pen.pooling, scale);
    }
  }
  ctx.restore();

  if (page.strokes.length > 0) drawStrokes(ctx, page.strokes, palette, pen, fontPx, scale, weight, plain);

  if (!plain) {
    // Ink does not go down evenly: pressure comes and goes, and the paper
    // takes it up more in some places than others.
    const density = pen.density * clamp(s.jitter.ink, 0, 2);
    if (density > 0.005) knockBack(ctx, densityTile(s.seed + pageIndex, scale, density, opts.createCanvas), s.seed, pageIndex);
    if (pen.grain > 0) {
      // Paper tooth: punch tiny holes in the stroke.
      knockBack(ctx, noiseTile(s.seed + pageIndex, 160, pen.grain, opts.createCanvas), s.seed, pageIndex);
    }
  }
}

/** Remove ink wherever a tile says so, tiled over the whole layer. */
function knockBack(ctx: Ctx2D, tile: AnyCanvas, seed: number, pageIndex: number): void {
  const pattern = ctx.createPattern(tile as CanvasImageSource, 'repeat');
  if (!pattern) return;
  ctx.save();
  // Shift the tile per page so no two pages share the same pattern.
  const ox = hashInts(seed, pageIndex, 0xde5) % tile.width;
  const oy = hashInts(pageIndex, seed, 0xde5) % tile.height;
  ctx.setTransform(1, 0, 0, 1, ox, oy);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.fillStyle = pattern;
  ctx.fillRect(-ox, -oy, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

/** Set the transform that puts a letter where the layout placed it. */
function placeGlyph(ctx: Ctx2D, g: PlacedGlyph, scale: number, x: number, y: number): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(x, y);
  if (g.rotation !== 0) ctx.rotate(g.rotation);
  if (g.skew !== 0) ctx.transform(1, 0, -g.skew, 1, 0, 0);
  ctx.scale(g.scaleX, g.scaleY);
}

/** The pen stroke-drawn letters are measured against. */
const BALLPOINT_LINE = 0.052;

const inkWidths = new WeakMap<Outline, number>();

/** How far right a letter's ink reaches, in em: the span the bend is measured over. */
function inkWidth(outline: Outline): number {
  let w = inkWidths.get(outline);
  if (w === undefined) {
    let max = 0.1;
    forEachPoint(outline, (x) => {
      if (x > max) max = x;
    });
    w = max;
    inkWidths.set(outline, w);
  }
  return w;
}

/**
 * A letter from the writer's own hand: each stroke is drawn as the pen moved,
 * after being bent like any other letter. The points are taken to the page
 * first, so the pen keeps its width however the letter leans.
 */
function drawStrokeGlyph(
  ctx: Ctx2D,
  g: PlacedGlyph,
  glyph: StrokeGlyph,
  shapes: GlyphShapes,
  pen: PenStyle,
  fontPx: number,
  scale: number,
  weight: number,
  plain: boolean,
  seed: number,
): void {
  // Your own letters already differ copy to copy; they are bent only a little.
  const warp =
    g.warp !== undefined && g.warp > 0
      ? createWarp({
          amount: glyph.own ? g.warp * 0.55 : g.warp,
          handSeed: glyph.own ? 0 : seed,
          unit: g.text,
          variant: g.variant ?? 0,
          instanceSeed: g.seed ?? 0,
          advance: glyph.advance,
          xHeight: shapes.xHeight,
          pinEnds: shapes.connected,
        })
      : null;
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  // The hand's own line weight, made heavier or lighter by the pen in use.
  const penScale = pen.lineWeight / BALLPOINT_LINE;
  const width =
    (shapes.strokeWeight ?? pen.lineWeight) * penScale * fontPx * Math.sqrt(g.scaleX * g.scaleY) * clamp(weight, 0.2, 3) * (0.85 + 0.3 * g.pressure);
  const shape = {
    width,
    nib: plain ? 0 : pen.nib * fontPx * 0.9,
    nibAngle: pen.nibAngle * (Math.PI / 180),
    taper: pen.taper,
    taperStart: true,
    taperEnd: true,
    taperLength: fontPx * 0.08,
  };
  const alpha = ctx.globalAlpha;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const rng = mulberry32(hashInts(g.seed ?? 0, 0x57e0));
  glyph.strokes.forEach((raw) => {
    const stroke = warpStroke(raw, warp);
    const pts = new Float32Array(stroke.length);
    for (let i = 0; i < stroke.length; i += 3) {
      // Scale, then lean, then turn, then move: the order the layout meant.
      const sx = stroke[i] * fontPx * g.scaleX;
      const sy = stroke[i + 1] * fontPx * g.scaleY;
      const kx = sx - g.skew * sy;
      pts[i] = g.x + kx * cos - sy * sin;
      pts[i + 1] = g.y + kx * sin + sy * cos;
      pts[i + 2] = stroke[i + 2];
    }
    const samples = smoothSamples(pts, 3, Math.max(0.25, 0.6 / scale));
    pressureAlong(samples, rng, plain ? 0 : 1);
    // Each stroke is its own pass of the pen, so where two cross, or a loop
    // closes over its start, the ink lies twice and comes out darker.
    ctx.globalAlpha = alpha * (0.9 + rng() * 0.1);
    ctx.beginPath();
    tracePenStroke(ctx, samples, shape);
    ctx.fill();
    // Now and then a ballpoint leaves a bead of ink where it touches down.
    if (!plain && samples.length > 3 && rng() < pen.pooling * 0.07) {
      const s0 = samples[0];
      ctx.globalAlpha = alpha * 0.85;
      ctx.beginPath();
      ctx.arc(s0.x, s0.y, width * (0.55 + rng() * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.globalAlpha = alpha;
}

/**
 * How hard the pen pressed along a stroke. A hand bears down on strokes that
 * pull towards it and eases off on those that push away, and the pressure
 * wanders a little on top of that; so down-strokes come out a shade wider.
 */
function pressureAlong(samples: { x: number; y: number; p: number }[], rng: () => number, amount: number): void {
  if (amount === 0 || samples.length < 3) return;
  const phase = rng() * Math.PI * 2;
  const wavelength = 6 + rng() * 6;
  let along = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    if (i > 0) along += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    const down = dy / len;
    const wobble = Math.sin(along / wavelength + phase) * 0.06;
    samples[i].p = Math.max(0.3, Math.min(1, samples[i].p * (0.86 + 0.14 * down + wobble)));
  }
}

const sketchCache = new Map<string, AnyCanvas>();

/**
 * A diagram copied out in pen.
 *
 * Most figures in a document are line art on white, so taking the luminance
 * of each pixel as how much ink belongs there, and drawing that in the
 * writer's own ink, reads as the figure having been copied by hand rather
 * than pasted in.
 *
 * A photograph is a different matter: it has no lines to copy, and tracing it
 * this way would leave a dark smear. Continuous-tone pictures are therefore
 * left as pictures — which is what ends up on a real page too, printed and
 * stuck on. The conversion is cached per size and colour, because it is the
 * one part of a page that costs real work.
 */
function inkTracing(source: CanvasImageSource, key: string, w: number, h: number, color: string, createCanvas: CanvasFactory): AnyCanvas {
  const id = `${key}:${color}:${w}x${h}`;
  const cached = sketchCache.get(id);
  if (cached) return cached;
  if (sketchCache.size > 12) sketchCache.clear();

  const canvas = createCanvas(w, h);
  const ctx = get2d(canvas);
  ctx.drawImage(source, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;

  if (!isLineArt(data)) {
    sketchCache.set(id, canvas);
    return canvas;
  }

  const [r, g, b] = parseHex(color);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    // Transparent areas are paper, so they count as white.
    const lit = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * alpha + 255 * (1 - alpha);
    const ink = clamp((208 - lit) / 118, 0, 1);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.round(255 * Math.pow(ink, 0.85));
  }
  ctx.putImageData(image, 0, 0);
  sketchCache.set(id, canvas);
  return canvas;
}

/**
 * Line art is mostly paper: a chart, a table or a drawing leaves the great
 * majority of its area white. A photograph does not, so the two can be told
 * apart by how much of the picture is nearly white.
 */
function isLineArt(data: Uint8ClampedArray): boolean {
  let pale = 0;
  let counted = 0;
  // Every eighth pixel is plenty to judge this by.
  for (let i = 0; i < data.length; i += 32) {
    const lit = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (data[i + 3] < 24 || lit > 232) pale++;
    counted++;
  }
  return counted === 0 || pale / counted > 0.55;
}

/** Release the cached diagram tracings (they are keyed by ink colour and size). */
export function releaseSketches(): void {
  sketchCache.clear();
}

function placeImage(ctx: Ctx2D, image: PlacedImage, scale: number, draw: (w: number, h: number) => void): void {
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.translate((image.x + image.width / 2) * scale, (image.y + image.height / 2) * scale);
  if (image.rotation !== 0) ctx.rotate(image.rotation);
  ctx.translate(-w / 2, -h / 2);
  draw(w, h);
  ctx.restore();
}

function drawSketchedImages(ctx: Ctx2D, images: PlacedImage[], s: Settings, opts: RenderOptions): void {
  const lookup = opts.images;
  if (!lookup) return;
  for (const image of images) {
    const source = lookup(image.id);
    if (!source) continue;
    placeImage(ctx, image, opts.scale, (w, h) => {
      const traced = inkTracing(source, image.id, w, h, s.inkColor, opts.createCanvas);
      ctx.drawImage(traced as CanvasImageSource, 0, 0);
    });
  }
}

/** A printed figure stuck onto the sheet, with the shadow that implies. */
function drawPastedImages(ctx: Ctx2D, images: PlacedImage[], opts: RenderOptions): void {
  const lookup = opts.images;
  if (!lookup) return;
  for (const image of images) {
    const source = lookup(image.id);
    if (!source) continue;
    placeImage(ctx, image, opts.scale, (w, h) => {
      ctx.globalAlpha = 0.28;
      if (supportsFilter(ctx)) ctx.filter = `blur(${Math.max(1, 0.5 * MM * opts.scale).toFixed(1)}px)`;
      ctx.fillStyle = 'rgba(40,36,30,0.9)';
      ctx.fillRect(2, 3, w, h);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.drawImage(source, 0, 0, w, h);
    });
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

/**
 * Underlines, strike-outs, carets, bullets, stray dots of ink and diagrams:
 * everything drawn with the pen that is not a letter. Each is drawn as a pen
 * stroke — thinning where the pen touches down and lifts off, broad across a
 * nib — rather than as a line of one width.
 */
function drawStrokes(
  ctx: Ctx2D,
  strokes: InkStroke[],
  palette: string[],
  pen: PenStyle,
  fontPx: number,
  scale: number,
  weight: number,
  plain: boolean,
): void {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const step = Math.max(0.25, 0.7 / scale);
  const nib = plain ? 0 : pen.nib * fontPx * 0.8;
  const nibAngle = pen.nibAngle * (Math.PI / 180);
  const flat: number[] = [];
  for (const stroke of strokes) {
    const color = palette[Math.round(clamp(stroke.shade, -1, 1) * SHADE_STEPS) + SHADE_STEPS];
    ctx.globalAlpha = stroke.opacity;
    ctx.fillStyle = color;
    const lw = Math.max(0.2, stroke.width * weight);
    flat.length = 0;
    for (const p of stroke.points) flat.push(p.x, p.y);
    const samples = stroke.points.length === 1 ? [{ x: flat[0], y: flat[1], p: 1 }] : smoothSamples(flat, 2, step);
    if (stroke.fill && stroke.points.length >= 3) {
      // Inked in: the inside of the outline, then the outline itself on top.
      ctx.beginPath();
      ctx.moveTo(flat[0], flat[1]);
      for (let k = 2; k < flat.length; k += 2) ctx.lineTo(flat[k], flat[k + 1]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    tracePenStroke(ctx, samples, {
      // A single point is a dab: its radius was given, not its width.
      width: stroke.points.length === 1 ? lw * 2 : lw,
      nib: stroke.points.length === 1 ? 0 : nib * Math.min(1, lw / (fontPx * 0.05)),
      nibAngle,
      taper: stroke.taper ? pen.taper : pen.taper * 0.3,
      taperStart: true,
      taperEnd: stroke.taper !== false,
      taperLength: fontPx * 0.25,
    });
    ctx.fill();
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

const densityCache = new Map<string, AnyCanvas>();

/**
 * A seamless tile saying how much ink to take away, and where: soft patches a
 * millimetre or so across, where the pen pressed less or the paper drank less,
 * and a fainter fine mottle inside them. Most of the tile takes nothing away.
 */
function densityTile(seed: number, scale: number, strength: number, createCanvas: CanvasFactory): AnyCanvas {
  const size = Math.round(clamp(30 * MM * scale, 96, 1400));
  const key = `${seed}:${size}:${strength.toFixed(3)}`;
  const cached = densityCache.get(key);
  if (cached) return cached;
  if (densityCache.size > 8) densityCache.clear();

  const canvas = createCanvas(size, size);
  const ctx = get2d(canvas);
  const img = ctx.createImageData(size, size);
  const rng = mulberry32(hashInts(seed, 0xd3a5));
  const octave = (cells: number) => {
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    const cell = size / cells;
    return (x: number, y: number) => {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx) % cells;
      const y0 = Math.floor(gy) % cells;
      const x1 = (x0 + 1) % cells;
      const y1 = (y0 + 1) % cells;
      const tx = smooth(gx - Math.floor(gx));
      const ty = smooth(gy - Math.floor(gy));
      const a = lattice[y0 * cells + x0] + (lattice[y0 * cells + x1] - lattice[y0 * cells + x0]) * tx;
      const b = lattice[y1 * cells + x0] + (lattice[y1 * cells + x1] - lattice[y1 * cells + x0]) * tx;
      return a + (b - a) * ty;
    };
  };
  // Patches about 2 mm across, and a mottle about a third of a millimetre.
  const coarse = octave(Math.max(4, Math.round(30 / 2)));
  const fine = octave(Math.max(8, Math.round(30 / 0.35)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const patch = coarse(x, y);
      const mottle = fine(x, y);
      const take = smooth(clamp((patch - 0.45) / 0.5, 0, 1)) * 0.85 + mottle * mottle * 0.2;
      img.data[(y * size + x) * 4 + 3] = Math.round(clamp(take * strength, 0, 1) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  densityCache.set(key, canvas);
  return canvas;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
