import {
  fontSizeFor,
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
  const geometry = pageGeometry(settings);
  const metrics = fontMetrics(font.family);
  const fontPx = fontSizeFor(geometry.spacing, settings.letterSize, metrics.xHeight, metrics.capHeight);
  const doc = layoutDocument(settings.text, geometry, fontPx, settings, createMeasurer(fontStack, fontPx), {
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
