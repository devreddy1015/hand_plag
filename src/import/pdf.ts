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
import type { Sketch, SketchLabel } from '../engine';
import { absorbText, clearFrames, findFigureBoxes, findTables, growToInk, roomAround, type Box } from './figures';
import { findMathBlocks, isBoldFont, isDrawingFont, isMathFont } from './math';
import { looksLikeLineArt, luminance, vectorize } from './vectorize';
import { buildLines, placeAccents, reconstruct, DEFAULT_PDF_OPTIONS, type Line, type PageFigure, type PageLines, type PdfOptions, type TextRun } from './reflow';
import type { ImportedImage, Importer } from './shared';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PdfOptions } from './reflow';

/**
 * Pages are rasterised at this resolution to find, cut out and trace figures:
 * fine enough that a hairline still comes out as a line to follow.
 */
const FIGURE_DPI = 192;
const PX_PER_PT = FIGURE_DPI / 72;
/** Nothing smaller than this (about 14 mm) counts as a figure. */
const MIN_FIGURE_MM = 14;
/** Widest a cut-out figure is kept: enough for print, small enough to hold. */
const MAX_FIGURE_PX = 1400;
/** Grid cell for the connected-block search, in rendered pixels. */
const CELL = 10;
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
      const all = await withFontKinds(page, content.items as TextItem[]);
      // Arrowheads and big brackets set in drawing fonts are part of a
      // picture, not words to write.
      const runs = all.filter((run) => !run.drawing);
      const lines = buildLines(runs, viewport.height, viewport.width);
      markBrokenMaths(lines, all, viewport.height);
      const entry: PageLines = { index: i - 1, width: viewport.width, height: viewport.height, lines };
      if (opts.diagrams) {
        try {
          entry.figures = await extractFigures(page, entry, runs, images);
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

/** A run of text, and what kind of font it is set in. */
interface KindedRun extends TextRun {
  /** Set in a font that only draws (arrowheads, big brackets): part of a picture. */
  drawing: boolean;
  /** Set in TeX's extension font: integral signs, big sums, tall brackets. */
  operator: boolean;
}

/**
 * An integral sign or a big bracket in the middle of a sentence was drawn, not
 * written, so it is missing from the words read back: "along path (1): v · dl
 * = 11" has lost its ∫. Such a line has to be copied out as it stands.
 */
function markBrokenMaths(lines: Line[], runs: KindedRun[], pageHeight: number): void {
  for (const run of runs) {
    if (!run.operator || !run.transform || run.str.trim() === '') continue;
    const x = run.transform[4];
    const y = pageHeight - run.transform[5];
    for (const line of lines) {
      if (x < line.x0 - line.size || x > line.x1 + line.size) continue;
      if (Math.abs(line.y - y) < line.size * 1.5) line.broken = true;
    }
  }
}

/**
 * Mark the runs set in a mathematics font, or a font used only for drawing.
 *
 * pdf.js reports only a generic family for each run ("sans-serif"), but the
 * real name of the embedded font is on the page once its operator list has
 * been parsed, and that name says plainly what the font is for.
 */
async function withFontKinds(page: PDFPageProxy, items: TextItem[]): Promise<KindedRun[]> {
  await page.getOperatorList();
  const known = new Map<string, { math: boolean; drawing: boolean; bold: boolean; operator: boolean }>();
  const kind = (id: string) => {
    let answer = known.get(id);
    if (answer === undefined) {
      let name: string | undefined;
      try {
        const font = page.commonObjs.get(id) as { name?: string; loadedName?: string } | undefined;
        name = font?.name ?? font?.loadedName;
      } catch {
        name = undefined;
      }
      answer = {
        math: isMathFont(name),
        drawing: isDrawingFont(name),
        bold: isBoldFont(name),
        operator: /CMEX|ESINT|MathExtension/i.test(name ?? ''),
      };
      known.set(id, answer);
    }
    return answer;
  };
  return items.map((item) => ({ ...item, ...kind(item.fontName) }));
}

/**
 * Rasterise a page that draws something, find the blocks of drawing that are
 * not text, and cut each one out: as a picture, and traced into the lines and
 * words a person would copy. Displayed equations are cut out the same way:
 * they are drawings of mathematics, not sentences.
 */
async function extractFigures(page: PDFPageProxy, entry: PageLines, runs: TextRun[], images: ImportedImage[]): Promise<PageFigure[]> {
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
  const placed = runs.map((run) => runBox(run, entry.height)).filter((b): b is RunBox => b !== null);
  maskText(grid, cols, rows, placed);
  // Boxes drawn round the writing are not figures, however big they are.
  const frames = clearFrames(
    grid,
    cols,
    rows,
    CELL,
    entry.lines.map((line) => ({
      x: line.x0 * PX_PER_PT,
      y: (line.y - line.size) * PX_PER_PT,
      width: (line.x1 - line.x0) * PX_PER_PT,
      height: line.size * 1.3 * PX_PER_PT,
    })),
  );
  // Displayed equations are cut out on their own. Their rules, roots and big
  // brackets are drawing too, and left in they join up with each other and
  // with any diagram nearby into one "figure" full of sentences.
  for (const box of maths.boxes) {
    const pad = bodySize * 0.3;
    maskBox(grid, cols, rows, (box.x - pad) * PX_PER_PT, (box.y - pad) * PX_PER_PT, (box.x + box.width + pad) * PX_PER_PT, (box.y + box.height + pad) * PX_PER_PT);
  }
  // Tables are copied out whole, rules and all, like a figure.
  const tables = findTables(
    entry.lines.filter((line) => !maths.consumed.has(line)),
    bodySize,
  );
  const tableBoxes = tables.boxes.map((box) => growToInk(box, inkReader(ctx, width, height), roomAround(box, entry.lines, tables.consumed, bodySize)));
  for (const box of tableBoxes) {
    maskBox(grid, cols, rows, box.x * PX_PER_PT, box.y * PX_PER_PT, (box.x + box.width) * PX_PER_PT, (box.y + box.height) * PX_PER_PT);
  }

  const minSize = MIN_FIGURE_MM * (FIGURE_DPI / 25.4);
  const boxesPx = findFigureBoxes(grid, cols, rows, {
    cell: CELL,
    pageWidth: width,
    pageHeight: height,
    minSize,
    spread: 3,
    rowGap: 22 * (FIGURE_DPI / 25.4),
  });

  const inPoints = boxesPx.map((b) => ({
    x: b.x / PX_PER_PT,
    y: b.y / PX_PER_PT,
    width: b.width / PX_PER_PT,
    height: b.height / PX_PER_PT,
  }));
  const { figures, consumed } = absorbText(
    inPoints,
    entry.lines.filter((line) => !tables.consumed.has(line)),
    bodySize,
    measureOf(entry.lines),
  );
  for (const box of tableBoxes) figures.push({ box, caption: '' });
  for (const line of tables.consumed) consumed.add(line);

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
  setOnFrameMargins(entry.lines, frames);

  const out: PageFigure[] = [];
  all.forEach((figure, n) => {
    const id = `pdf-${entry.index + 1}-${n + 1}`;
    const pad = figure.kind === 'math' ? 2 : 6;
    const crop = cropOf(canvas, figure.box, pad);
    if (!crop) return;
    const picture = cutOut(canvas, crop, id);
    if (!picture) return;
    picture.kind = figure.kind;
    picture.pointWidth = figure.box.width;
    picture.sourceSize = bodySize;
    const labels = placed.filter((run) => writable(run.text) && insideCrop(run, crop));
    const sketch = traceCrop(ctx, crop, labels);
    if (sketch) picture.sketch = sketch;
    else if (figure.kind === 'figure') picture.kind = 'photo';
    images.push(picture);
    out.push({ id, top: figure.box.y, bottom: figure.box.y + figure.box.height, caption: figure.caption });
  });

  release(canvas);
  return out;
}

/** A run of text as a box on the rendered page, in pixels. */
interface RunBox {
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  size: number;
}

function runBox(run: TextRun, pageHeight: number): RunBox | null {
  const t = run.transform;
  if (!t || t.length < 6 || !run.str || run.str.trim() === '') return null;
  // Text on its side is left in the picture, to be traced with it.
  if (Math.abs(t[1]) > Math.abs(t[0]) * 0.35 + 0.01) return null;
  const size = Math.max(Math.hypot(t[2], t[3]), run.height || 0) || 10;
  return {
    text: run.str.trim(),
    x: t[4] * PX_PER_PT,
    y: (pageHeight - t[5]) * PX_PER_PT,
    width: Math.max(1, run.width * PX_PER_PT),
    size: size * PX_PER_PT,
  };
}

/** Can this be written out in a hand? Private-use glyphs and the like cannot. */
function writable(text: string): boolean {
  return text !== '' && !/[\ue000-\uf8ff\ufffd\u0000-\u001f]/.test(text);
}

interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

function cropOf(page: HTMLCanvasElement, box: Box, pad: number): Crop | null {
  const x = Math.max(0, Math.floor(box.x * PX_PER_PT) - pad);
  const y = Math.max(0, Math.floor(box.y * PX_PER_PT) - pad);
  const w = Math.min(page.width - x, Math.ceil(box.width * PX_PER_PT) + pad * 2);
  const h = Math.min(page.height - y, Math.ceil(box.height * PX_PER_PT) + pad * 2);
  return w < 8 || h < 8 ? null : { x, y, w, h };
}

function insideCrop(run: RunBox, crop: Crop): boolean {
  const cx = run.x + run.width / 2;
  const cy = run.y - run.size * 0.3;
  return cx > crop.x && cx < crop.x + crop.w && cy > crop.y && cy < crop.y + crop.h;
}

/**
 * Trace a cut-out figure into pen paths, leaving out the words: those are
 * written in the hand instead, where they stood.
 */
function traceCrop(ctx: CanvasRenderingContext2D, crop: Crop, labels: RunBox[]): Sketch | null {
  const data = ctx.getImageData(crop.x, crop.y, crop.w, crop.h).data;
  const lum = luminance(data);
  if (!looksLikeLineArt(lum)) return null;
  const ignore = new Uint8Array(crop.w * crop.h);
  for (const run of labels) {
    const pad = Math.max(1, run.size * 0.06);
    const x0 = Math.max(0, Math.floor(run.x - crop.x - pad));
    const x1 = Math.min(crop.w - 1, Math.ceil(run.x + run.width - crop.x + pad));
    const y0 = Math.max(0, Math.floor(run.y - run.size * 0.82 - crop.y - pad));
    const y1 = Math.min(crop.h - 1, Math.ceil(run.y + run.size * 0.26 - crop.y + pad));
    for (let y = y0; y <= y1; y++) ignore.fill(1, y * crop.w + x0, y * crop.w + x1 + 1);
  }
  const traced = vectorize(lum, crop.w, crop.h, ignore, {}, data);
  if (!traced) return null;
  const k = 1 / crop.w;
  // A hat set over a letter is part of the letter, not a label of its own.
  const pieces = labels.map((run) => ({ x: run.x, width: run.width, str: run.text, y: run.y, size: run.size }));
  placeAccents(pieces);
  labels = labels.map((run, i) => ({ ...run, text: pieces[i].str })).filter((run) => run.text.trim() !== '');
  const sketchLabels: SketchLabel[] = labels.map((run) => ({
    text: run.text,
    x: (run.x - crop.x) * k,
    y: (run.y - crop.y) * k,
    w: run.width * k,
    size: run.size * k,
  }));
  return {
    aspect: crop.w / crop.h,
    paths: traced.paths.map((p) => ({ pts: p.pts.map((v) => v * k), weight: p.weight, closed: p.closed })),
    fills: traced.fills.map((f) => ({ pts: f.pts.map((v) => v * k), area: f.area * k * k, tone: f.tone, group: f.group })),
    labels: sketchLabels,
    lineWidth: traced.lineWidth * k,
  };
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

/** Clear the cells each run of text covers: words are not diagrams. */
function maskText(grid: Uint8Array, cols: number, rows: number, runs: RunBox[]): void {
  for (const run of runs) {
    // Tight to the run itself, so a line passing close by — the shaft of an
    // arrow between two labelled boxes — is not wiped out with it.
    const pad = Math.max(1, run.size * 0.08);
    maskBox(grid, cols, rows, run.x - pad, run.y - run.size * 0.8 - pad, run.x + run.width + pad, run.y + run.size * 0.25 + pad);
  }
}

/** Clear the cells under a rectangle given in rendered pixels. */
function maskBox(grid: Uint8Array, cols: number, rows: number, x0: number, y0: number, x1: number, y1: number): void {
  for (let r = Math.max(0, Math.floor(y0 / CELL)); r <= Math.min(rows - 1, Math.floor(y1 / CELL)); r++) {
    for (let c = Math.max(0, Math.floor(x0 / CELL)); c <= Math.min(cols - 1, Math.floor(x1 / CELL)); c++) {
      grid[r * cols + c] = 0;
    }
  }
}

/**
 * Text in a box is set on the box's own margin, a little in from the page's.
 * Measured from the page it would all look indented — a quotation, or a list
 * whose bullets were drawn — so move each box's lines back out to the margin
 * the box stands on. Frames are in rendered pixels.
 */
function setOnFrameMargins(lines: Line[], frames: Box[]): void {
  for (const frame of frames) {
    const left = frame.x / PX_PER_PT;
    const top = frame.y / PX_PER_PT;
    const bottom = (frame.y + frame.height) / PX_PER_PT;
    const right = (frame.x + frame.width) / PX_PER_PT;
    const inside = lines.filter((line) => line.y > top && line.y < bottom && line.x0 >= left && line.x1 <= right + 1);
    if (inside.length === 0) continue;
    const shift = Math.min(...inside.map((line) => line.x0)) - left;
    if (shift <= 0) continue;
    for (const line of inside) {
      line.x0 -= shift;
      line.x1 -= shift;
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
function cutOut(page: HTMLCanvasElement, crop: Crop, id: string): ImportedImage | null {
  const { x: sx, y: sy, w: sw, h: sh } = crop;
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
