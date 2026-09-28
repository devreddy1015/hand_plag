import {
  drawPaper,
  fontSizeFor,
  get2d,
  graphemes,
  hasSymbol,
  layoutDocument,
  LATIN_TWINS,
  pageGeometry,
  penWeightOf,
  renderPage,
  symbolGlyph,
  writtenForm,
  type AnyCanvas,
  type CanvasFactory,
  type DocumentLayout,
  type GlyphShapes,
  type ImageInfo,
  type Measurer,
  type Settings,
} from './engine';
import { createMeasurer, cssFontStack, fallbackScaler, findFont, fontFamiliesFor, fontMetrics, loadFonts, type FontEntry } from './fonts';
import { pictureImage, pictureMetrics } from './images';
import { loadOutlines, type OutlineFont } from './outlines';

export interface Prepared {
  settings: Settings;
  doc: DocumentLayout;
  fontStack: string;
  /** Where the renderer gets each letter's outline, so it can bend it. */
  shapes: GlyphShapes;
}

export const createCanvas: CanvasFactory = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** Load fonts and lay out the whole document. */
export async function prepare(settings: Settings): Promise<Prepared> {
  const font = findFont(settings.fontId);
  const families = fontFamiliesFor(font, settings.text);
  const [, outlines] = await Promise.all([loadFonts(families, settings.text), loadOutlines(font.family)]);
  const fontStack = cssFontStack(families);
  const geometryOf = (pageIndex: number) => pageGeometry(settings, pageIndex);
  const geometry = geometryOf(0);
  // Your own hand has its own proportions; the stand-in only fills gaps.
  const metrics = font.hand ? { xHeight: font.hand.xHeight, capHeight: font.hand.capHeight } : fontMetrics(font.family);
  const fontPx = fontSizeFor(geometry.spacing, settings.letterSize, metrics.xHeight, metrics.capHeight);
  const shapes = shapesFor(font, outlines, metrics.xHeight, metrics.capHeight);
  const measure = withStrokeGlyphs(createMeasurer(fontStack, fontPx), shapes, fontPx);
  const doc = layoutDocument(settings.text, geometryOf, fontPx, settings, measure, {
    connected: font.connected,
    unitScale: unitScaler(font, families),
    imageSize: (src) => imageSizeFor(src, settings, geometry.spacing),
    substitute: substituter(outlines, font),
  });
  return { settings, doc, fontStack, shapes };
}

function shapesFor(font: FontEntry, outlines: OutlineFont | null, xHeight: number, capHeight: number): GlyphShapes {
  // Greek and mathematics the hand has no letters for are drawn with the pen.
  const known = new Map<string, boolean>();
  const drawn = (unit: string) => {
    let yes = known.get(unit);
    if (yes === undefined) {
      yes = hasSymbol(unit) && (outlines === null || !outlines.has(unit));
      known.set(unit, yes);
    }
    return yes;
  };
  const hand = font.hand;
  return {
    xHeight,
    capHeight,
    connected: font.connected === true,
    outline: (unit) => outlines?.outline(unit) ?? null,
    strokeGlyph: (unit, variant) => hand?.glyph(unit, variant) ?? (drawn(unit) ? symbolGlyph(unit, xHeight, capHeight) : null),
    strokeWeight: hand ? hand.weight : penWeightOf(outlines?.outline('-') ?? null),
  };
}

/**
 * Size factor for each unit. Letters from fallback fonts are matched to the
 * main hand's x-height; in a hand of your own, so are the stand-in's letters
 * for anything you have not written yet.
 */
function unitScaler(font: FontEntry, families: string[]): (unit: string) => number {
  const fallback = fallbackScaler(font, families);
  const hand = font.hand;
  if (!hand) return fallback;
  const standIn = hand.xHeight / Math.max(0.1, fontMetrics(font.family).xHeight);
  return (unit) => (hand.has(unit) ? 1 : fallback(unit) * standIn);
}

/**
 * Measure text the way it will be drawn: a character drawn with the pen is as
 * wide as its own glyph, not as wide as whatever font the browser would have
 * put in its place.
 */
function withStrokeGlyphs(measure: Measurer, shapes: GlyphShapes, fontPx: number): Measurer {
  const glyphWidth = (unit: string): number | null => {
    const glyph = shapes.strokeGlyph?.(unit, 0);
    return glyph ? glyph.advance * fontPx : null;
  };
  return (text) => {
    if (/^[\x20-\x7e]*$/.test(text)) return measure(text);
    let total = 0;
    let run = '';
    for (const unit of graphemes(text)) {
      const w = glyphWidth(unit);
      if (w === null) {
        run += unit;
        continue;
      }
      if (run !== '') total += measure(run);
      run = '';
      total += w;
    }
    if (run !== '') total += measure(run);
    return total;
  };
}

/**
 * What to write for a character the hand has no letter for. A hand with no
 * outlines to ask is left to the browser, as before.
 */
function substituter(outlines: OutlineFont | null, font: FontEntry): ((unit: string) => string) | undefined {
  if (!outlines) return undefined;
  const cache = new Map<string, string>();
  const has = (unit: string) => font.hand?.has(unit) === true || outlines.has(unit);
  return (unit) => {
    let out = cache.get(unit);
    if (out === undefined) {
      out = unit;
      if (!has(unit)) {
        const twin = LATIN_TWINS[unit];
        const plain = writtenForm(unit);
        if (twin && (has(twin) || hasSymbol(twin))) out = twin;
        else if (hasSymbol(unit)) out = unit;
        else if (plain !== unit && has(plain.charAt(0))) out = plain;
      }
      cache.set(unit, out);
    }
    return out;
  };
}

/**
 * How big a picture wants to be. An equation cut out of a document is drawn at
 * the size of the writing around it — work out how much bigger the hand is
 * than the type it came from, and scale it by that.
 */
function imageSizeFor(src: string, settings: Settings, spacing: number): ImageInfo | null {
  const picture = pictureMetrics(src);
  if (!picture) return null;
  const base: ImageInfo = { width: picture.width, height: picture.height, kind: picture.kind, sketch: picture.sketch };
  if (picture.kind !== 'math' || !picture.pointWidth || !picture.sourceSize) return base;
  const PT = 96 / 72;
  // x-height is close enough to 45% of the type size for this purpose.
  const sourceXHeight = picture.sourceSize * PT * 0.45;
  const handXHeight = settings.letterSize * spacing;
  const scale = sourceXHeight > 0 ? handXHeight / sourceXHeight : 1;
  return { ...base, widthUnits: picture.pointWidth * PT * scale };
}

export function drawPage(target: AnyCanvas, prepared: Prepared, pageIndex: number, scale: number): void {
  renderPage(target, prepared.doc, pageIndex, prepared.settings, {
    scale,
    fontStack: prepared.fontStack,
    createCanvas,
    images: pictureImage,
    shapes: prepared.shapes,
  });
}

/**
 * Paint an empty sheet: used for the paper-template thumbnails, so the gallery
 * shows the real thing rather than a drawing of it.
 */
export function drawPaperOnly(target: AnyCanvas, settings: Settings, widthPx: number): void {
  const geom = pageGeometry(settings, 0);
  const scale = widthPx / geom.width;
  const w = Math.max(1, Math.round(geom.width * scale));
  const h = Math.max(1, Math.round(geom.height * scale));
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;
  const ctx = get2d(target);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // Grain is invisible at thumbnail size and costs a tile render per template.
  drawPaper(ctx, geom, { ...settings, texture: false }, scale, 0, createCanvas);
}
