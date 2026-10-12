/**
 * Handwriting engine. Portable: it needs only a Canvas 2D implementation
 * (browser, OffscreenCanvas in a worker, or skia/node-canvas on a server)
 * and a text measurer, so the same code can back the web app and a future
 * rendering API.
 */
export * from './types';
export { DEFAULT_SETTINGS, SAMPLE_TEXT, withDefaults } from './defaults';
export { INK_BANDS, layoutDocument, type ImageInfo, type InkSpan, type LayoutOptions } from './layout';
export { releaseLayers, releaseSketches, renderPage } from './render';
export { PAPER_SIZES, drawPaper, get2d, pageGeometry, type AnyCanvas, type CanvasFactory } from './paper';
export { PAPER_TEMPLATES, applyTemplate, findTemplate } from './templates';
export { detectScripts, graphemes, scriptOf, writtenForm, type ScriptTag } from './segment';
export { penFor } from './pen';
export { LATIN_TWINS, hasMarks, hasSymbol, parseStrokes, symbolCharacters, symbolGlyph, withMarks } from './symbols';
export {
  OutlineBuilder,
  createWarp,
  outlineInk,
  penWeightOf,
  traceOutline,
  type GlyphShapes,
  type Outline,
  type PathSink,
  type StrokeGlyph,
} from './shapes';

/**
 * Font size in layout units that gives the requested x-height, capped so tall
 * capitals stay within about one line.
 */
export function fontSizeFor(spacing: number, letterSize: number, xHeightRatio: number, capHeightRatio: number): number {
  const byXHeight = (letterSize * spacing) / xHeightRatio;
  const byCap = (spacing * 1.05) / capHeightRatio;
  return Math.max(4, Math.min(byXHeight, byCap));
}
