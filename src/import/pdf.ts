/**
 * Reading a PDF back into plain, structured text — and its diagrams.
 *
 * pdf.js parses the file in its own worker and hands back positioned runs of
 * text; `reflow.ts` turns those back into a document. Figures need more than
 * that: a PDF never says "this is a diagram", so a page that draws anything is
 * rasterised, the text is masked out of the picture, and whatever is left is
 * treated as figures (`figures.ts`) and cut out of the rendered page.
 *
 * Everything happens in the browser, so the file never leaves the device.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import { absorbText, findFigureBoxes, growToInk, roomAround, type Box } from './figures';
import { findMathBlocks, isMathFont } from './math';
import { buildLines, reconstruct, DEFAULT_PDF_OPTIONS, type Line, type PageFigure, type PageLines, type PdfOptions, type TextRun } from './reflow';
import type { ImportedImage, Importer } from './shared';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PdfOptions } from './reflow';

/** Pages are rasterised at this resolution to find and cut out figures. */
const FIGURE_DPI = 144;
const PX_PER_PT = FIGURE_DPI / 72;
/** Nothing smaller than this (about 14 mm) counts as a figure. */
const MIN_FIGURE_MM = 14;
/** Widest a cut-out figure is kept: enough for print, small enough to hold. */
const MAX_FIGURE_PX = 1400;
/** Grid cell for the connected-block search, in rendered pixels. */
const CELL = 8;
/** Below this luminance a pixel counts as drawn rather than paper. */
const INK_LEVEL = 186;

export const importPdf: Importer<Partial<PdfOptions>> = async (file, onProgress, options) => {
  const opts = { ...DEFAULT_PDF_OPTIONS, ...options };
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  const images: ImportedImage[] = [];

  try {
    const pages: PageLines[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const runs = opts.diagrams ? await withMathFonts(page, content.items as TextItem[]) : (content.items as TextRun[]);
      const lines = buildLines(runs, viewport.height, viewport.width);
      const entry: PageLines = { index: i - 1, width: viewport.width, height: viewport.height, lines };
      if (opts.diagrams) {
        try {
          entry.figures = await extractFigures(page, entry, images);
        } catch (err) {
          // A figure that cannot be cut out is no reason to lose the text.
          console.warn('Could not read the diagrams on page', i, err);
        }
      }
      pages.push(entry);
      page.cleanup();
      onProgress?.(i, doc.numPages);
    }

    if (pages.every((p) => p.lines.length === 0 && (p.figures?.length ?? 0) === 0)) {
      return {
        text: '',
        pageCount: doc.numPages,
        warnings: [
          'This PDF holds no text, only page images — it was scanned or exported as pictures. Run it through OCR first, or paste the text in.',
        ],
      };
    }

    const { text, warnings } = reconstruct(pages, opts);
    if (images.length > 0) warnings.push(`Brought over ${images.length} diagram${images.length === 1 ? '' : 's'}.`);
    return { text, pageCount: doc.numPages, warnings, images };
  } finally {
    await task.destroy();
  }
};

/**
 * Mark the runs set in a mathematics font.
 *
 * pdf.js reports only a generic family for each run ("sans-serif"), but the
 * real name of the embedded font is on the page once its operator list has
 * been parsed, and that name says plainly whether it is a maths font.
 */
async function withMathFonts(page: PDFPageProxy, items: TextItem[]): Promise<TextRun[]> {
  await page.getOperatorList();
  const known = new Map<string, boolean>();
  const mathFont = (id: string): boolean => {
    let answer = known.get(id);
    if (answer === undefined) {
      let name: string | undefined;
      try {
        const font = page.commonObjs.get(id) as { name?: string; loadedName?: string } | undefined;
        name = font?.name ?? font?.loadedName;
      } catch {
        name = undefined;
      }
      answer = isMathFont(name);
      known.set(id, answer);
    }
    return answer;
  };
  return items.map((item) => ({ ...item, math: mathFont(item.fontName) }));
}

/**
 * Rasterise a page that draws something, find the blocks of drawing that are
 * not text, and cut each one out as a picture. Displayed equations are cut out
 * the same way: they are drawings of mathematics, not sentences.
 */
async function extractFigures(page: PDFPageProxy, entry: PageLines, images: ImportedImage[]): Promise<PageFigure[]> {
  const bodySizeFirst = bodySizeOf(entry.lines);
  const maths = findMathBlocks(entry.lines, {
    bodyLeft: leftOf(entry.lines),
    bodyRight: rightOf(entry.lines),
    leading: leadingOf(entry.lines, bodySizeFirst),
    bodySize: bodySizeFirst,
  });
  if (maths.boxes.length === 0 && !(await drawsAnything(page))) return [];

  const viewport = page.getViewport({ scale: PX_PER_PT });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;

  const bodySize = bodySizeOf(entry.lines);
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const grid = drawnCells(ctx.getImageData(0, 0, width, height).data, width, height, cols, rows);
  maskText(grid, cols, rows, entry.lines, bodySize);

  const minSize = MIN_FIGURE_MM * (FIGURE_DPI / 25.4);
  const boxesPx = findFigureBoxes(grid, cols, rows, { cell: CELL, pageWidth: width, pageHeight: height, minSize, spread: 3 });

  const inPoints = boxesPx.map((b) => ({
    x: b.x / PX_PER_PT,
    y: b.y / PX_PER_PT,
    width: b.width / PX_PER_PT,
    height: b.height / PX_PER_PT,
  }));
  const { figures, consumed } = absorbText(inPoints, entry.lines, bodySize, measureOf(entry.lines));

  // An equation drawn inside a figure is part of that figure, not a second one.
  const equations = maths.boxes
    .filter((box) => !figures.some((figure) => overlaps(figure.box, box)))
    // A rule, a root or a big bracket reaches past the glyphs the box was
    // measured from, so grow it until it stops touching ink — but never far
    // enough to clip the top off the sentence underneath.
    .map((box) => growToInk(box, inkReader(ctx, width, height), roomAround(box, entry.lines, maths.consumed)));
  const all = [
    ...figures.map((figure) => ({ box: figure.box, caption: figure.caption, kind: 'figure' as const })),
    ...equations.map((box) => ({ box, caption: '', kind: 'math' as const })),
  ].sort((a, b) => a.box.y - b.box.y);

  for (const line of maths.consumed) consumed.add(line);
  if (consumed.size > 0) entry.lines = entry.lines.filter((line) => !consumed.has(line));

  const out: PageFigure[] = [];
  all.forEach((figure, n) => {
    const id = `pdf-${entry.index + 1}-${n + 1}`;
    const picture = cutOut(canvas, figure.box, id, figure.kind === 'math' ? 1 : 5);
    if (!picture) return;
    picture.kind = figure.kind;
    picture.pointWidth = figure.box.width;
    picture.sourceSize = bodySize;
    images.push(picture);
    out.push({ id, top: figure.box.y, bottom: figure.box.y + figure.box.height, caption: figure.caption });
  });

  release(canvas);
  return out;
}

/** Asks whether anything is drawn in a strip of the rendered page. */
function inkReader(ctx: CanvasRenderingContext2D, width: number, height: number) {
  return (x: number, y: number, w: number, h: number): boolean => {
    const sx = Math.max(0, Math.round(x * PX_PER_PT));
    const sy = Math.max(0, Math.round(y * PX_PER_PT));
    const sw = Math.min(width - sx, Math.max(1, Math.round(w * PX_PER_PT)));
    const sh = Math.min(height - sy, Math.max(1, Math.round(h * PX_PER_PT)));
    if (sw <= 0 || sh <= 0 || sx >= width || sy >= height) return false;
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    for (let i = 0; i < data.length; i += 4) {
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_LEVEL) return true;
    }
    return false;
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The left margin of the running text: the edge most lines start from. */
function leftOf(lines: Line[]): number {
  if (lines.length === 0) return 0;
  const lefts = lines.map((l) => l.x0).sort((a, b) => a - b);
  return lefts[Math.floor(lefts.length * 0.12)];
}

function rightOf(lines: Line[]): number {
  if (lines.length === 0) return Infinity;
  const rights = lines.map((l) => l.x1).sort((a, b) => a - b);
  return rights[Math.floor(rights.length * 0.9)];
}

/** The usual distance between two lines of running text. */
function leadingOf(lines: Line[], bodySize: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].y - lines[i - 1].y;
    if (gap > 0.5 && gap < bodySize * 4) gaps.push(gap);
  }
  if (gaps.length === 0) return bodySize * 1.2;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function release(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

/** Does this page paint an image, or draw more than the odd rule? */
async function drawsAnything(page: PDFPageProxy): Promise<boolean> {
  const { OPS } = pdfjs;
  const painters = new Set(
    [
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintImageMaskXObjectRepeat,
    ].filter((op) => typeof op === 'number'),
  );
  // The operator list is kept on the page, so asking for it costs nothing the
  // render below would not have paid anyway.
  const list = await page.getOperatorList();
  let paths = 0;
  for (const op of list.fnArray) {
    if (painters.has(op)) return true;
    if (op === OPS.constructPath) paths++;
  }
  return paths >= 4;
}

/** One flag per grid cell: is anything drawn in it? */
function drawnCells(data: Uint8ClampedArray, width: number, height: number, cols: number, rows: number): Uint8Array {
  const grid = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / CELL) * cols;
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      const lit = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lit >= INK_LEVEL) continue;
      grid[row + Math.floor(x / CELL)] = 1;
    }
  }
  return grid;
}

/** Clear the cells the running text covers: words are not diagrams. */
function maskText(grid: Uint8Array, cols: number, rows: number, lines: Line[], bodySize: number): void {
  const pad = Math.max(1.5, bodySize * 0.25) * PX_PER_PT;
  for (const line of lines) {
    const x0 = (line.x0 * PX_PER_PT - pad) / CELL;
    const x1 = (line.x1 * PX_PER_PT + pad) / CELL;
    const y0 = ((line.y - line.size) * PX_PER_PT - pad) / CELL;
    const y1 = ((line.y + line.size * 0.35) * PX_PER_PT + pad) / CELL;
    for (let r = Math.max(0, Math.floor(y0)); r <= Math.min(rows - 1, Math.ceil(y1)); r++) {
      for (let c = Math.max(0, Math.floor(x0)); c <= Math.min(cols - 1, Math.ceil(x1)); c++) {
        grid[r * cols + c] = 0;
      }
    }
  }
}

/** The width of a full line of running text on this page. */
function measureOf(lines: Line[]): number {
  if (lines.length === 0) return Infinity;
  const widths = lines.map((l) => l.x1 - l.x0).sort((a, b) => a - b);
  return widths[Math.floor(widths.length * 0.9)];
}

function bodySizeOf(lines: Line[]): number {
  if (lines.length === 0) return 11;
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

/** Copy one figure out of the rendered page, at a sensible size. */
function cutOut(page: HTMLCanvasElement, box: Box, id: string, pad = 5): ImportedImage | null {
  const sx = Math.max(0, Math.floor(box.x * PX_PER_PT) - pad);
  const sy = Math.max(0, Math.floor(box.y * PX_PER_PT) - pad);
  const sw = Math.min(page.width - sx, Math.ceil(box.width * PX_PER_PT) + pad * 2);
  const sh = Math.min(page.height - sy, Math.ceil(box.height * PX_PER_PT) + pad * 2);
  if (sw < 8 || sh < 8) return null;

  const shrink = Math.min(1, MAX_FIGURE_PX / sw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * shrink));
  canvas.height = Math.max(1, Math.round(sh * shrink));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(page, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const picture = { id, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  release(canvas);
  return picture;
}
