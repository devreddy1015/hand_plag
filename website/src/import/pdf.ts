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
// The legacy build carries what pdf.js needs from newer JavaScript (such as
// Uint8Array.toHex, only in Chrome 140 and later), so a PDF still opens in an
// older browser or in a phone's WebView that has not been updated.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
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
      const all = (await withFontKinds(page, content.items as TextItem[])).map(inlineOperator);
      // Arrowheads and big brackets set in drawing fonts are part of a
      // picture, not words to write.
      const runs = all.filter((run) => !run.drawing);
      const lines = buildLines(runs, viewport.height, viewport.width);
      markBrokenMaths(lines, all, viewport.height);
      // The bar of a root is drawn, not written: read back as words, √z² + x²
      // no longer says how much of the sum is under it.
      for (const line of lines) if (line.text.includes('\u221a')) line.broken = true;
      const entry: PageLines = { index: i - 1, width: viewport.width, height: viewport.height, lines };
      if (opts.diagrams) {
        try {
          entry.figures = await extractFigures(page, entry, runs, all.filter((run) => run.drawing || run.operator), images);
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
 * TeX's extension font carries no character map, so its glyphs come out as
 * the codes of their places in the font: an integral set in a sentence reads
 * as "R". The operators set at the size of the text are named here, so that a
 * sentence holding one is written out, ∫ and all, rather than copied as a
 * picture of itself.
 */
const INLINE_OPERATORS: Record<string, string> = {
  H: '\u222e',
  P: '\u2211',
  Q: '\u220f',
  R: '\u222b',
  // The smallest of the big brackets, \big( and \big[.
  '\u0000': '(',
  '\u0001': ')',
  '\u0002': '[',
  '\u0003': ']',
};

function inlineOperator(run: KindedRun): KindedRun {
  // The root sign hangs from where it is placed as well; read at face value
  // it floats a line above the sum it stands over.
  if (run.math && !run.operator && run.transform && run.str.trim() === '\u221a') {
    const t = [...run.transform];
    t[5] -= (Math.hypot(t[2], t[3]) || 10) * 0.8;
    return { ...run, transform: t };
  }
  const chars = [...run.str.trim()];
  if (!run.operator || !run.transform || chars.length === 0 || !chars.every((c) => c in INLINE_OPERATORS)) return run;
  const name = chars.map((c) => INLINE_OPERATORS[c]).join('');
  const t = [...run.transform];
  // It hangs from where it is placed, centred on the maths axis: its
  // baseline is most of its height further down.
  t[5] -= (Math.hypot(t[2], t[3]) || 10) * 0.8;
  return { ...run, str: name, transform: t, drawing: false, operator: false, math: true };
}

/**
 * An integral sign or a big bracket in the middle of a sentence was drawn, not
 * written, so it is missing from the words read back: "along path (1): v · dl
 * = 11" has lost its ∫. Such a line has to be copied out as it stands.
 */
function markBrokenMaths(lines: Line[], runs: KindedRun[], pageHeight: number): void {
  for (const run of runs) {
    if (!run.operator || !run.transform || run.str.trim() === '') continue;
    const t = run.transform;
    const x = t[4];
    // TeX's big symbols hang from their baseline: the middle of the glyph is
    // half its size below where it is placed.
    const middle = pageHeight - t[5] + Math.hypot(t[2], t[3]) * 0.5;
    const end = x + (run.width || 0);
    for (const line of lines) {
      // Inside the sentence, not after it: a displayed formula's integral
      // sits where the sentence around it has already stopped. Or just in
      // front of it: a formula that opens with its integral sign, its limit
      // perhaps set between the two.
      const opens = end <= line.x0 + 1 && end >= line.x0 - line.size * 3;
      if (!opens && (x <= line.x0 || x >= line.x1)) continue;
      if (Math.abs(middle - (line.y - line.size * 0.3)) < line.size * 0.8) line.broken = true;
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
async function extractFigures(
  page: PDFPageProxy,
  entry: PageLines,
  runs: TextRun[],
  drawn: TextRun[],
  images: ImportedImage[],
): Promise<PageFigure[]> {
  const bodySizeFirst = bodySizeOf(entry.lines);
  const maths = findMathBlocks(entry.lines, {
    bodyLeft: leftOf(entry.lines),
    bodyRight: rightOf(entry.lines),
    leading: leadingOf(entry.lines, bodySizeFirst),
    bodySize: bodySizeFirst,
  });
  reachDelimiters(maths.boxes, drawn, entry.height, bodySizeFirst);
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
  // Equations are already spoken for: a figure that took them as labels
  // would grow over every formula set beside it.
  const { figures, consumed } = absorbText(
    inPoints,
    entry.lines.filter((line) => !tables.consumed.has(line) && !maths.consumed.has(line)),
    bodySize,
    measureOf(entry.lines),
  );
  for (const box of tableBoxes) figures.push({ box, caption: '' });
  for (const line of tables.consumed) consumed.add(line);

  // An equation drawn inside a figure is part of that figure, not a second
  // one; the figure takes in whatever of it pokes out.
  const equations = maths.boxes
    .map((box, i) => ({ box, own: new Set(maths.blocks[i]), prose: maths.prose[i] }))
    .filter(({ box }) => {
      const host = figures.find((figure) => shared(figure.box, box) >= area(box) * 0.5);
      if (host) host.box = unite(host.box, box);
      return !host;
    })
    // A rule, a root or a big bracket reaches past the glyphs the box was
    // measured from, so grow it until it stops touching ink — but never far
    // enough to clip the top off the line underneath, even when that line is
    // another equation.
    .map(({ box, own, prose }) => ({ box: growToInk(box, inkReader(ctx, width, height), roomAround(box, entry.lines, own)), prose }));
  // Two pieces of one formula found apart — its main line, and the rows of
  // fractions over and under it — come out as boxes lying mostly over each
  // other. They are one formula, copied once.
  for (let joined = true; joined; ) {
    joined = false;
    for (let i = 0; i < equations.length && !joined; i++) {
      for (let j = i + 1; j < equations.length && !joined; j++) {
        const a = equations[i].box;
        const b = equations[j].box;
        if (shared(a, b) < Math.min(area(a), area(b)) * 0.3) continue;
        equations[i] = { box: unite(a, b), prose: equations[i].prose && equations[j].prose };
        equations.splice(j, 1);
        joined = true;
      }
    }
  }
  const all = [
    ...figures.map((figure) => ({ box: figure.box, caption: figure.caption, kind: 'figure' as const, prose: false })),
    ...equations.map(({ box, prose }) => ({ box, caption: '', kind: 'math' as const, prose })),
  ].sort((a, b) => a.box.y - b.box.y);

  for (const line of maths.consumed) consumed.add(line);
  if (consumed.size > 0) entry.lines = entry.lines.filter((line) => !consumed.has(line));
  setOnFrameMargins(entry.lines, frames);

  const out: PageFigure[] = [];
  // Every word is copied once, into the first cut-out that holds it.
  const taken = new Set<RunBox>();
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
    const words = placed.filter((run) => writable(run.text) && insideCrop(run, crop));
    const labels = words.filter((run) => !taken.has(run));
    for (const run of labels) taken.add(run);
    // Words written with another cut-out are still words, not lines to trace.
    const sketch = traceCrop(ctx, crop, labels, figure.kind === 'math', words);
    if (sketch && figure.prose) sketch.prose = true;
    if (sketch) picture.sketch = sketch;
    else if (figure.kind === 'figure') picture.kind = 'photo';
    images.push(picture);
    // An equation is read where its middle is: its box reaches up past the
    // line before it wherever a root or a limit stands tall.
    const top = figure.kind === 'math' ? figure.box.y + figure.box.height / 2 : figure.box.y;
    out.push({ id, top, bottom: figure.box.y + figure.box.height, caption: figure.caption });
  });

  release(canvas);
  return out;
}

/**
 * Big brackets and integral signs are set in a font that draws, so no line of
 * text reaches them: an equation box measured from its lines stops short of
 * its own closing bracket, and the bracket left outside is taken for a piece
 * of drawing. Widen each box over the big symbols on its rows. In points.
 */
function reachDelimiters(boxes: Box[], drawn: TextRun[], pageHeight: number, bodySize: number): void {
  const symbols = drawn
    .filter((run) => run.transform && run.str.trim() !== '')
    .map((run) => {
      const t = run.transform;
      const size = Math.hypot(t[2], t[3]) || bodySize;
      // They hang from where they are placed.
      const top = pageHeight - t[5];
      return { x: t[4], y: top, width: Math.max(1, run.width), height: size };
    });
  for (const box of boxes) {
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of symbols) {
        const middle = s.y + s.height / 2;
        if (middle < box.y || middle > box.y + box.height) continue;
        if (s.x + s.width < box.x - bodySize * 1.5 || s.x > box.x + box.width + bodySize * 1.5) continue;
        const x0 = Math.min(box.x, s.x);
        const x1 = Math.max(box.x + box.width, s.x + s.width);
        if (x0 > box.x - 0.01 && x1 < box.x + box.width + 0.01) continue;
        box.x = x0;
        box.width = x1 - x0;
        grew = true;
      }
    }
  }
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
function traceCrop(ctx: CanvasRenderingContext2D, crop: Crop, labels: RunBox[], maths = false, words: RunBox[] = labels): Sketch | null {
  const data = ctx.getImageData(crop.x, crop.y, crop.w, crop.h).data;
  const lum = luminance(data);
  if (!looksLikeLineArt(lum)) return null;
  const ignore = new Uint8Array(crop.w * crop.h);
  for (const run of words) {
    const pad = Math.max(1, run.size * 0.06);
    const x0 = Math.max(0, Math.floor(run.x - crop.x - pad));
    const x1 = Math.min(crop.w - 1, Math.ceil(run.x + run.width - crop.x + pad));
    const y0 = Math.max(0, Math.floor(run.y - run.size * 0.82 - crop.y - pad));
    const y1 = Math.min(crop.h - 1, Math.ceil(run.y + run.size * 0.26 - crop.y + pad));
    for (let y = y0; y <= y1; y++) ignore.fill(1, y * crop.w + x0, y * crop.w + x1 + 1);
  }
  // A rule running on past the words — the bar of a root over its sum, the
  // line of a fraction — is drawn, not written, even where it passes over
  // them. No letter has a stroke across it half so long.
  if (words.length > 0) {
    const sizes = words.map((run) => run.size).sort((a, b) => a - b);
    const long = Math.max(6, sizes[Math.floor(sizes.length / 2)] * 1.3);
    for (let y = 0; y < crop.h; y++) {
      const row = y * crop.w;
      let start = -1;
      for (let x = 0; x <= crop.w; x++) {
        const dark = x < crop.w && lum[row + x] < INK_LEVEL;
        if (dark && start < 0) start = x;
        if (!dark && start >= 0) {
          if (x - start >= long) ignore.fill(0, row + start, row + x);
          start = -1;
        }
      }
    }
  }
  const traced = vectorize(lum, crop.w, crop.h, ignore, {}, data);
  if (!traced) return null;
  // Specks left round the words of an equation — the tail of an italic
  // letter reaching past its box — are not lines anyone drew. (A figure's
  // short strokes are its dashes and ticks, and stay.)
  if (maths && labels.length > 0) {
    const sizes = labels.map((run) => run.size).sort((a, b) => a - b);
    const speck = sizes[Math.floor(sizes.length / 2)] * 0.18;
    traced.paths = traced.paths.filter((path) => {
      const xs = path.pts.filter((_, i) => i % 2 === 0);
      const ys = path.pts.filter((_, i) => i % 2 === 1);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= speck;
    });
  }
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

function area(box: Box): number {
  return box.width * box.height;
}

/** How much of two boxes lies in both. */
function shared(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function unite(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * The left margin of the running text: the edge most lines start from. Only
 * lines of some length count — on a page of equations, the pieces of the
 * formulas far outnumber the sentences, and all of them are set in.
 */
function leftOf(lines: Line[]): number {
  if (lines.length === 0) return 0;
  const widest = Math.max(...lines.map((l) => l.x1 - l.x0));
  const long = lines.filter((l) => l.x1 - l.x0 >= widest * 0.5);
  const lefts = (long.length >= 3 ? long : lines).map((l) => l.x0).sort((a, b) => a - b);
  return lefts[Math.floor(lefts.length * 0.12)];
}

function rightOf(lines: Line[]): number {
  if (lines.length === 0) return Infinity;
  const rights = lines.map((l) => l.x1).sort((a, b) => a - b);
  return rights[Math.floor(rights.length * 0.9)];
}

/**
 * The usual distance between two lines of running text: between two lines of
 * a paragraph, that is, not the pieces of a fraction, which sit far closer.
 */
function leadingOf(lines: Line[], bodySize: number): number {
  const widest = Math.max(0, ...lines.map((l) => l.x1 - l.x0));
  const long = lines.filter((l) => l.x1 - l.x0 >= widest * 0.5);
  const gaps: number[] = [];
  for (let i = 1; i < long.length; i++) {
    const gap = long[i].y - long[i - 1].y;
    if (gap > bodySize * 0.8 && gap < bodySize * 2) gaps.push(gap);
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
