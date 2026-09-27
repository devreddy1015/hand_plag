import {
  drawPaper,
  fontSizeFor,
  get2d,
  layoutDocument,
  pageGeometry,
  renderPage,
  type AnyCanvas,
  type CanvasFactory,
  type DocumentLayout,
  type Settings,
} from './engine';
import { createMeasurer, cssFontStack, fallbackScaler, findFont, fontFamiliesFor, fontMetrics, loadFonts } from './fonts';
import { pictureImage, pictureMetrics } from './images';

export interface Prepared {
  settings: Settings;
  doc: DocumentLayout;
  fontStack: string;
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
  await loadFonts(families, settings.text);
  const fontStack = cssFontStack(families);
  const geometryOf = (pageIndex: number) => pageGeometry(settings, pageIndex);
  const geometry = geometryOf(0);
  const metrics = fontMetrics(font.family);
  const fontPx = fontSizeFor(geometry.spacing, settings.letterSize, metrics.xHeight, metrics.capHeight);
  const doc = layoutDocument(settings.text, geometryOf, fontPx, settings, createMeasurer(fontStack, fontPx), {
    connected: font.connected,
    unitScale: fallbackScaler(font, families),
    imageSize: (src) => imageSizeFor(src, settings, geometry.spacing),
  });
  return { settings, doc, fontStack };
}

/**
 * How big a picture wants to be. An equation cut out of a document is drawn at
 * the size of the writing around it — work out how much bigger the hand is
 * than the type it came from, and scale it by that.
 */
function imageSizeFor(src: string, settings: Settings, spacing: number): { width: number; height: number; widthUnits?: number } | null {
  const picture = pictureMetrics(src);
  if (!picture) return null;
  if (picture.kind !== 'math' || !picture.pointWidth || !picture.sourceSize) {
    return { width: picture.width, height: picture.height };
  }
  const PT = 96 / 72;
  // x-height is close enough to 45% of the type size for this purpose.
  const sourceXHeight = picture.sourceSize * PT * 0.45;
  const handXHeight = settings.letterSize * spacing;
  const scale = sourceXHeight > 0 ? handXHeight / sourceXHeight : 1;
  return { width: picture.width, height: picture.height, widthUnits: picture.pointWidth * PT * scale };
}

export function drawPage(target: AnyCanvas, prepared: Prepared, pageIndex: number, scale: number): void {
  renderPage(target, prepared.doc, pageIndex, prepared.settings, {
    scale,
    fontStack: prepared.fontStack,
    createCanvas,
    images: pictureImage,
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
