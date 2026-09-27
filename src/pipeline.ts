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
  });
  return { settings, doc, fontStack };
}

export function drawPage(target: AnyCanvas, prepared: Prepared, pageIndex: number, scale: number): void {
  renderPage(target, prepared.doc, pageIndex, prepared.settings, {
    scale,
    fontStack: prepared.fontStack,
    createCanvas,
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
