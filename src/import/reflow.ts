/**
 * Rebuilding a document from positioned text.
 *
 * A PDF has no paragraphs: it has thousands of positioned glyph runs. Getting
 * a document back means reconstructing, in order, what the typesetter threw
 * away — lines, columns, paragraphs, headings, lists, hyphenation and the
 * running heads that should not be written out again.
 *
 * Nothing here knows about pdf.js: it works on plain positioned runs, so it
 * can be tested on its own and reused for any other source of laid-out text.
 */
import { cleanText, joinBroken } from './shared';

export interface PdfOptions {
  /** Start a new sheet where the source document started a new page. */
  keepPageBreaks: boolean;
  /** Recover headings as `#` lines. */
  detectHeadings: boolean;
  /** Drop running headers, footers and page numbers. */
  dropRunningHeads: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = { keepPageBreaks: false, detectHeadings: true, dropRunningHeads: true };

/** One positioned run of text, as pdf.js reports it. */
export interface TextRun {
  str: string;
  /** Text matrix: [a, b, c, d, e, f], with e and f the origin in PDF units. */
  transform: number[];
  width: number;
  height: number;
}

export interface Line {
  /** Baseline in PDF units, measured down from the top of the page. */
  y: number;
  x0: number;
  x1: number;
  size: number;
  text: string;
  /** Column this line belongs to (0 for single-column pages). */
  column: number;
}

export interface PageLines {
  index: number;
  width: number;
  height: number;
  lines: Line[];
}

/** Lines, then columns, then paragraphs: the whole reconstruction. */
export function reconstruct(pages: PageLines[], opts: PdfOptions): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  if (opts.dropRunningHeads) dropRunningHeads(pages, warnings);
  return { text: assemble(pages, opts), warnings };
}

interface Run {
  /** Baseline measured down from the top of the page. */
  y: number;
  x: number;
  width: number;
  size: number;
  str: string;
}

/**
 * Group positioned runs into lines of text, in reading order.
 *
 * Columns are found first, because the two columns of a page share their
 * baselines: grouping by vertical position alone would weave the left and
 * right columns into one unreadable line.
 */
export function buildLines(items: TextRun[], pageHeight: number, pageWidth: number): Line[] {
  const runs: Run[] = [];
  for (const item of items) {
    if (!item.str || item.str.trim() === '') continue;
    const t = item.transform;
    if (!t || t.length < 6) continue;
    // Skip text turned on its side: page furniture, watermarks, figure labels.
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.35 + 0.01) continue;
    const size = Math.max(Math.hypot(t[2], t[3]), item.height || 0) || 10;
    runs.push({ y: pageHeight - t[5], x: t[4], width: item.width, size, str: item.str });
  }
  if (runs.length === 0) return [];

  const sizes = runs.map((r) => r.size).sort((a, b) => a - b);
  const typical = sizes[Math.floor(sizes.length / 2)];

  const gutter = findGutter(runs, pageWidth);
  if (gutter === null) return groupRuns(runs, typical, 0);

  const left = runs.filter((r) => r.x + r.width <= gutter + 1);
  const right = runs.filter((r) => r.x >= gutter - 1);
  const wide = runs.filter((r) => r.x < gutter - 1 && r.x + r.width > gutter + 1);
  if (left.length < runs.length * 0.15 || right.length < runs.length * 0.15) return groupRuns(runs, typical, 0);

  return orderColumns([...groupRuns(left, typical, 0), ...groupRuns(right, typical, 1), ...groupRuns(wide, typical, -1)]);
}

/** Runs that share a baseline become one line, read left to right. */
function groupRuns(runs: Run[], typicalSize: number, column: number): Line[] {
  if (runs.length === 0) return [];
  const tolerance = Math.max(1.2, typicalSize * 0.45);
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  let bucket: Run[] = [];
  let bucketY = sorted[0].y;

  const flush = () => {
    if (bucket.length === 0) return;
    bucket.sort((a, b) => a.x - b.x);
    let text = '';
    let cursor = -Infinity;
    let size = 0;
    for (const run of bucket) {
      const gap = run.x - cursor;
      if (text !== '' && gap > run.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(run.str)) text += ' ';
      text += run.str;
      cursor = run.x + run.width;
      size = Math.max(size, run.size);
    }
    const trimmed = cleanText(text);
    if (trimmed !== '') {
      lines.push({
        y: bucket.reduce((s, r) => s + r.y, 0) / bucket.length,
        x0: bucket[0].x,
        x1: cursor,
        size,
        text: trimmed,
        column,
      });
    }
    bucket = [];
  };

  for (const run of sorted) {
    if (bucket.length > 0 && Math.abs(run.y - bucketY) > tolerance) {
      flush();
      bucketY = run.y;
    } else if (bucket.length === 0) {
      bucketY = run.y;
    }
    bucket.push(run);
  }
  flush();
  return lines;
}

/**
 * The x of a vertical band down the middle of the page that no run crosses.
 * Returns null when the page is set in a single column.
 */
function findGutter(runs: Run[], pageWidth: number): number | null {
  if (runs.length < 12 || pageWidth <= 0) return null;
  const BINS = 100;
  const covered = new Uint8Array(BINS);
  for (const run of runs) {
    const from = clampBin(Math.floor((run.x / pageWidth) * BINS));
    const to = clampBin(Math.ceil(((run.x + run.width) / pageWidth) * BINS));
    for (let i = from; i <= to; i++) covered[i] = 1;
  }
  let bestStart = -1;
  let bestLen = 0;
  let start = -1;
  for (let i = Math.floor(BINS * 0.33); i <= Math.ceil(BINS * 0.67); i++) {
    if (covered[i] === 0) {
      if (start < 0) start = i;
      if (i - start + 1 > bestLen) {
        bestLen = i - start + 1;
        bestStart = start;
      }
    } else {
      start = -1;
    }
  }
  if (bestLen < 3) return null;
  return ((bestStart + bestLen / 2) / BINS) * pageWidth;
}

/**
 * Read down one column, then the other. A line that spans the whole measure
 * (a title, a wide table) closes both columns and is read where it sits.
 */
function orderColumns(lines: Line[]): Line[] {
  const byY = (a: Line, b: Line) => a.y - b.y;
  const full = lines.filter((l) => l.column === -1).sort(byY);
  const columns = [0, 1].map((c) => lines.filter((l) => l.column === c).sort(byY));
  const taken = [0, 0];
  const out: Line[] = [];
  for (const wide of full) {
    for (const c of [0, 1]) {
      while (taken[c] < columns[c].length && columns[c][taken[c]].y < wide.y) out.push(columns[c][taken[c]++]);
    }
    out.push(wide);
  }
  for (const c of [0, 1]) {
    while (taken[c] < columns[c].length) out.push(columns[c][taken[c]++]);
  }
  return out;
}

function clampBin(v: number): number {
  return Math.max(0, Math.min(99, v));
}

/** Drop the lines a publisher repeats at the top or bottom of every page. */
export function dropRunningHeads(pages: PageLines[], warnings: string[]): void {
  if (pages.length < 3) return;
  const counts = new Map<string, number>();
  const key = (line: Line) => line.text.replace(/\d+/g, '#').trim().toLowerCase();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const line of page.lines) {
      if (!inMargin(line, page)) continue;
      const k = key(line);
      if (k.length < 2 || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(pages.length * 0.5));
  const repeated = new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k));
  let removed = 0;
  for (const page of pages) {
    page.lines = page.lines.filter((line) => {
      if (!inMargin(line, page)) return true;
      // A bare number in the margin is a page number whether it repeats or not.
      if (/^[ivxlcdm]{1,7}$|^\d{1,4}$|^[-–—\s]*\d{1,4}[-–—\s]*$/i.test(line.text)) {
        removed++;
        return false;
      }
      if (repeated.has(key(line))) {
        removed++;
        return false;
      }
      return true;
    });
  }
  if (removed > 0) warnings.push(`Left out ${removed} running header, footer or page-number line${removed === 1 ? '' : 's'}.`);
}

function inMargin(line: Line, page: PageLines): boolean {
  return line.y < page.height * 0.09 || line.y > page.height * 0.91;
}

/** One block of the rebuilt document, before it is written out as text. */
interface OutBlock {
  kind: 'paragraph' | 'heading' | 'list' | 'pagebreak';
  text: string;
  /** Left edge of the block's first line, used to spot indented lists. */
  indent: number;
  level: number;
  marker: string;
}

/**
 * Turn ordered lines into paragraphs, headings and lists.
 *
 * The signals available are crude — the size of the type, the left edge, the
 * space above a line, and whether the line before it stopped short — so each
 * decision is made from several of them at once rather than any one alone.
 */
export function assemble(pages: PageLines[], opts: PdfOptions): string {
  const all = pages.flatMap((p) => p.lines);
  if (all.length === 0) return '';

  const bodySize = weightedMode(all.map((l) => [round(l.size, 1), l.text.length]));
  // The body margin is the leftmost edge most lines share; everything else
  // (list items, quotations, first-line indents) is set in from it. A low
  // percentile finds it without being thrown by the odd line further left.
  const bodyLeft = percentile(
    all.map((l) => l.x0),
    0.12,
  );
  const bodyRight = percentile(
    all.map((l) => l.x1),
    0.92,
  );
  const gaps: number[] = [];
  for (const page of pages) {
    for (let i = 1; i < page.lines.length; i++) {
      const gap = page.lines[i].y - page.lines[i - 1].y;
      if (gap > 0.5 && gap < bodySize * 4) gaps.push(gap);
    }
  }
  const lineGap = gaps.length > 0 ? weightedMode(gaps.map((g) => [round(g, 0), 1])) || median(gaps) : bodySize * 1.2;
  const isShort = (line: Line) => line.x1 < bodyRight - bodySize * 2.5;

  const blocks: OutBlock[] = [];
  /** The block being built. A list item stays open so its later lines join it. */
  let pending: { kind: 'paragraph' | 'list'; marker: string; indent: number; lines: string[] } | null = null;

  const flush = () => {
    if (pending === null || pending.lines.length === 0) {
      pending = null;
      return;
    }
    blocks.push({ kind: pending.kind, text: joinBroken(pending.lines), indent: pending.indent, level: 0, marker: pending.marker });
    pending = null;
  };
  const emit = (block: Omit<OutBlock, 'level' | 'marker'> & Partial<OutBlock>) => {
    flush();
    blocks.push({ level: 0, marker: '', ...block });
  };
  const open = (kind: 'paragraph' | 'list', marker: string, indent: number, text: string) => {
    flush();
    pending = { kind, marker, indent, lines: [text] };
  };

  /** The line before this one, which may be on the page before. */
  let previous: Line | null = null;
  let previousOnThisPage = false;

  for (const page of pages) {
    if (opts.keepPageBreaks && page.index > 0) {
      emit({ kind: 'pagebreak', text: '[[page]]', indent: 0 });
      previous = null;
    }
    previousOnThisPage = false;
    for (const line of page.lines) {
      // Vertical space is only meaningful between two lines of the same page
      // and the same column.
      const gapAbove = previousOnThisPage && previous && previous.column === line.column ? line.y - previous.y : null;
      const ratio = line.size / bodySize;
      const words = line.text.split(/\s+/).length;
      const short = isShort(line);
      const prevShort = previous === null || isShort(previous);
      const caps = line.text.length > 2 && line.text === line.text.toUpperCase() && /[A-Z]{2}/.test(line.text);
      const airAbove = gapAbove === null || gapAbove > lineGap * 1.25;

      // Headings: bigger type, a line shouted in capitals, or a short line in
      // slightly larger type standing on its own with space above it.
      if (
        opts.detectHeadings &&
        words <= 18 &&
        (ratio >= 1.12 || (caps && short && ratio >= 0.95) || (ratio >= 1.03 && short && airAbove && !/[.!?,;]$/.test(line.text)))
      ) {
        const level = ratio >= 1.45 ? 1 : ratio >= 1.2 ? 2 : 3;
        emit({ kind: 'heading', text: stripTrailingDot(line.text), indent: line.x0, level });
        previous = line;
        previousOnThisPage = true;
        continue;
      }

      // Lists keep their own marker, so the numbering stays the author's.
      const bullet = /^([\u2022\u25aa\u2023\u00b7\u25cf\u25cb\u2013-]|\*)\s+(.*)$/.exec(line.text);
      const numbered = /^(\(?\d{1,3}[.)]|[a-z][.)]|[ivx]{1,4}[.)])\s+(.+)$/i.exec(line.text);
      if (bullet) {
        open('list', '-', line.x0, bullet[2]);
        previous = line;
        previousOnThisPage = true;
        continue;
      }
      // Once a list is open, a numbered line is another item in it. On its
      // own, a number mid-paragraph ("in 1997. The year...") is not a list,
      // so starting one needs space above it or a short line before it.
      if (numbered && (airAbove || prevShort || pending?.kind === 'list')) {
        open('list', numbered[1].replace(/^\(/, ''), line.x0, numbered[2]);
        previous = line;
        previousOnThisPage = true;
        continue;
      }

      // Otherwise this line either continues the open block or starts one.
      // A list item's later lines sit under its text, so they may be indented
      // further than its marker without meaning a new block.
      const indented =
        pending !== null && line.x0 > pending.indent + bodySize * (pending.kind === 'list' ? 3 : 0.8);
      const previousEnded = previous !== null && prevShort && /[.!?:;"\u201d')\]]$/.test(previous.text);
      const gapBreak = gapAbove !== null && gapAbove > lineGap * (prevShort ? 1.12 : 1.45);
      if (pending !== null && (gapBreak || indented || previousEnded)) flush();
      if (pending === null) pending = { kind: 'paragraph', marker: '', indent: line.x0, lines: [] };
      pending.lines.push(line.text);
      previous = line;
      previousOnThisPage = true;
    }
  }
  flush();

  markIndentedLists(blocks, bodyLeft, bodySize);

  const out = blocks.map((b) => {
    if (b.kind === 'heading') return `${'#'.repeat(Math.min(3, Math.max(1, b.level)))} ${b.text}`;
    if (b.kind === 'list') return `${b.marker} ${b.text}`;
    return b.text;
  });
  return out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Some PDFs draw list bullets as graphics rather than text, so all that is
 * left of a list is a run of short blocks sharing an indent. Two or more of
 * those in a row are written out as a bulleted list.
 */
function markIndentedLists(blocks: OutBlock[], bodyLeft: number, bodySize: number): void {
  let start = 0;
  const closeRun = (end: number) => {
    if (end - start < 2) return;
    for (let i = start; i < end; i++) {
      blocks[i].kind = 'list';
      blocks[i].marker = '-';
    }
  };
  for (let i = 0; i <= blocks.length; i++) {
    const block = blocks[i];
    const indented = block !== undefined && block.kind === 'paragraph' && block.indent > bodyLeft + bodySize * 0.8;
    const sameRun = indented && i > start && Math.abs(block.indent - blocks[start].indent) < bodySize * 0.5;
    if (indented && (i === start || sameRun)) continue;
    closeRun(i);
    start = indented ? i : i + 1;
  }
}

function stripTrailingDot(text: string): string {
  return text.replace(/\s*[.·:]\s*$/, '');
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/** The value carrying the most weight; ties go to the smaller value. */
function weightedMode(entries: [number, number][]): number {
  const weights = new Map<number, number>();
  for (const [value, weight] of entries) weights.set(value, (weights.get(value) ?? 0) + weight);
  let best = 0;
  let bestWeight = -1;
  for (const [value, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && value < best)) {
      bestWeight = weight;
      best = value;
    }
  }
  return best;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
