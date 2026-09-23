/**
 * Handwriting engine. Portable: it needs only a Canvas 2D implementation
 * (browser, OffscreenCanvas in a worker, or skia/node-canvas on a server)
 * and a text measurer, so the same code can back the web app and a future
 * rendering API.
 */
export * from './types';
export { DEFAULT_SETTINGS, SAMPLE_TEXT, withDefaults } from './defaults';
export { layoutDocument, PAGE_BREAK, type LayoutOptions } from './layout';
export { renderPage, type RenderOptions } from './render';
export { MM, PAPER_SIZES, findPaperSize, get2d, pageGeometry, type AnyCanvas, type CanvasFactory, type Ctx2D } from './paper';
export { detectScripts, graphemes, scriptOf, tokenize, type ScriptTag } from './segment';

/**
 * Font size in layout units that gives the requested x-height, capped so tall
 * capitals stay within about one line.
 */
export function fontSizeFor(spacing: number, letterSize: number, xHeightRatio: number, capHeightRatio: number): number {
  const byXHeight = (letterSize * spacing) / xHeightRatio;
  const byCap = (spacing * 1.05) / capHeightRatio;
  return Math.max(4, Math.min(byXHeight, byCap));
}
