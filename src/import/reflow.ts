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
  /** Bring the diagrams over as well as the words. */
  diagrams: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = { keepPageBreaks: false, detectHeadings: true, dropRunningHeads: true, diagrams: true };

/** One positioned run of text, as pdf.js reports it. */
export interface TextRun {
  str: string;
  /** Text matrix: [a, b, c, d, e, f], with e and f the origin in PDF units. */
  transform: number[];
  width: number;
  height: number;
  /** Set when the run is drawn in a font only used for mathematics. */
  math?: boolean;
  /** Set when the run is drawn in a bold face. */
  bold?: boolean;
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
  /** Share of the line, by length, set in a mathematics font. */
  math: number;
  /** Share of the line, by length, set in bold. */
  bold?: number;
  /**
   * The line holds maths that cannot be read back as text: a fraction set
   * inline, with its numerator over its denominator, or an integral sign
   * drawn rather than written. It has to be copied out as it stands.
   */
  broken?: boolean;
}

/** A figure found on the page, ready to be written into the flow. */
export interface PageFigure {
  /** Key of the picture in the image registry. */
  id: string;
  /** Top and bottom of the figure, measured down from the top of the page. */
  top: number;
  bottom: number;
  caption: string;
}

export interface PageLines {
  index: number;
  width: number;
  height: number;
  lines: Line[];
  /** Diagrams found on this page, if they were looked for. */
  figures?: PageFigure[];
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
  math: boolean;
  bold: boolean;
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
    runs.push({ y: pageHeight - t[5], x: t[4], width: item.width, size, str: item.str, math: item.math === true, bold: item.bold === true });
  }
  if (runs.length === 0) return [];

  const sizes = runs.map((r) => r.size).sort((a, b) => a - b);
  const typical = sizes[Math.floor(sizes.length / 2)];

  const gutter = findGutter(runs, pageWidth);
  // Words this far apart on one baseline are not one line of text: a figure's
  // label beside a paragraph, the two halves of a running head, a page number
  // at the end of a contents entry.
  const apart = Math.max(typical * 3, pageWidth * 0.05);
  if (gutter === null) return groupRuns(runs, typical, 0, apart);

  const left = runs.filter((r) => r.x + r.width <= gutter + 1);
  const right = runs.filter((r) => r.x >= gutter - 1);
  const wide = runs.filter((r) => r.x < gutter - 1 && r.x + r.width > gutter + 1);
  if (left.length < runs.length * 0.15 || right.length < runs.length * 0.15) return groupRuns(runs, typical, 0, apart);

  return orderColumns([...groupRuns(left, typical, 0, apart), ...groupRuns(right, typical, 1, apart), ...groupRuns(wide, typical, -1, apart)]);
}

/** Runs that share a baseline become one line, read left to right. */
function groupRuns(runs: Run[], typicalSize: number, column: number, apart = Infinity): Line[] {
  if (runs.length === 0) return [];
  const tolerance = Math.max(1.2, typicalSize * 0.45);
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  let bucket: Run[] = [];
  let bucketY = sorted[0].y;

  const flush = () => {
    if (bucket.length === 0) return;
    bucket.sort((a, b) => a.x - b.x);
    placeAccents(bucket);
    let from = 0;
    let reach = bucket[0].x + bucket[0].width;
    for (let i = 1; i <= bucket.length; i++) {
      if (i < bucket.length && bucket[i].x - reach <= apart) {
        reach = Math.max(reach, bucket[i].x + bucket[i].width);
        continue;
      }
      const line = lineOf(bucket.slice(from, i), column);
      if (line) lines.push(line);
      if (i < bucket.length) reach = bucket[i].x + bucket[i].width;
      from = i;
    }
    bucket = [];
  };

  // A line is measured from its own type, not from whatever run happened to
  // come first: that may be a superscript sitting above it.
  let bucketSize = 0;
  for (const run of sorted) {
    if (bucket.length > 0 && Math.abs(run.y - bucketY) > tolerance) {
      flush();
      bucketY = run.y;
      bucketSize = run.size;
    } else if (bucket.length === 0 || run.size > bucketSize * 1.1) {
      bucketY = run.y;
      bucketSize = run.size;
    }
    bucket.push(run);
  }
  flush();
  return lines;
}

/** One line from runs on one baseline, already in order from left to right. */
function lineOf(bucket: Run[], column: number): Line | null {
  // The line's own type: the run with the most characters in it. Anything
  // markedly smaller and off its baseline is a superscript or subscript —
  // a footnote mark, a power, the 2 of CO2 — and is kept as one.
  let main = bucket[0];
  for (const run of bucket) if (run.str.trim().length > main.str.trim().length) main = run;
  let text = '';
  let cursor = -Infinity;
  let size = 0;
  let mathChars = 0;
  let boldChars = 0;
  let allChars = 0;
  /** The kind of script just written, so a power set in two pieces stays one. */
  let lastScript = '';
  const raised: Run[] = [];
  const dropped: Run[] = [];
  for (const run of bucket) {
    if (run.str === '') continue;
    const gap = run.x - cursor;
    const script = run !== main && run.size < main.size * 0.86 && Math.abs(run.y - main.y) > main.size * 0.1 && run.str.trim() !== '';
    if (script) {
      const kind = run.y < main.y ? '^' : '_';
      (kind === '^' ? raised : dropped).push(run);
      if (kind === lastScript && gap < run.size * 0.3) text = `${text.slice(0, -1)}${run.str.trim()}}`;
      else text += `${kind}{${run.str.trim()}}`;
      lastScript = kind;
    } else {
      lastScript = '';
      if (text !== '' && gap > run.size * 0.18 && !/\s$/.test(text) && !/^[\s\u0300-\u036f]/.test(run.str)) text += ' ';
      text += run.str;
    }
    cursor = run.x + run.width;
    size = Math.max(size, script ? 0 : run.size);
    const length = run.str.trim().length;
    allChars += length;
    if (run.math) mathChars += length;
    if (run.bold) boldChars += length;
  }
  const trimmed = cleanText(text);
  if (trimmed === '') return null;
  // A numerator standing over a denominator is a fraction, not a power
  // followed by an index.
  const stacked = raised.some((up) =>
    dropped.some((down) => Math.min(up.x + up.width, down.x + down.width) - Math.max(up.x, down.x) > Math.min(up.width, down.width) * 0.3),
  );
  return {
    broken: stacked || undefined,
    // The baseline of the line's own type, not pulled about by its scripts.
    y: main.y,
    x0: bucket[0].x,
    x1: cursor,
    size,
    text: trimmed,
    column,
    math: allChars > 0 ? mathChars / allChars : 0,
    bold: allChars > 0 ? boldChars / allChars : 0,
  };
}

/** Spacing accents, and the combining marks they stand for. */
const ACCENTS: Record<string, string> = {
  '\u02c6': '\u0302',
  '\u02dc': '\u0303',
  '\u00af': '\u0304',
  '\u02c9': '\u0304',
  '\u02d9': '\u0307',
  '\u00a8': '\u0308',
  '\u00b4': '\u0301',
  '\u02c7': '\u030c',
  '\u02d8': '\u0306',
  '\u02da': '\u030a',
};

/**
 * Put accents back on their letters. TeX sets the hat of a unit vector as a
 * glyph of its own, placed over the letter, so read in order it lands beside
 * the letter — "nˆ" or "ˆn" — rather than on it. Each spacing accent is
 * joined, as a combining mark, to the letter it stands over.
 */
export function placeAccents(bucket: { x: number; width: number; str: string; y?: number; size?: number }[]): void {
  interface Char {
    run: number;
    index: number;
    ch: string;
    mid: number;
    x0: number;
    x1: number;
  }
  const chars: Char[][] = bucket.map((run, r) => {
    const points = [...run.str];
    const step = run.width / Math.max(1, points.length);
    return points.map((ch, index) => ({ run: r, index, ch, x0: run.x + step * index, x1: run.x + step * (index + 1), mid: run.x + step * (index + 0.5) }));
  });
  const flat = chars.flat();
  if (!flat.some((c) => ACCENTS[c.ch] !== undefined)) return;
  const letter = (c: Char) => /[\p{L}\p{N}]/u.test(c.ch);
  const marks = new Map<Char, string>();
  const dropped = new Set<Char>();
  for (const c of flat) {
    const mark = ACCENTS[c.ch];
    if (mark === undefined) continue;
    // The letter beneath: in another run, under the middle of the accent.
    let base: Char | undefined;
    let best = Infinity;
    const at = bucket[c.run];
    for (const o of flat) {
      if (o.run === c.run || !letter(o)) continue;
      // Pieces from all over a figure: the letter must be on the accent's own line.
      const under = bucket[o.run];
      if (at.y !== undefined && under.y !== undefined && Math.abs(at.y - under.y) > (under.size ?? Infinity) * 0.9) continue;
      const slack = (o.x1 - o.x0) * 0.35;
      if (c.mid < o.x0 - slack || c.mid > o.x1 + slack) continue;
      const d = Math.abs(o.mid - c.mid);
      if (d < best) {
        best = d;
        base = o;
      }
    }
    // Failing that, the letter right after it in its own run.
    if (!base) base = chars[c.run].find((o) => o.index === c.index + 1 && letter(o));
    if (!base || marks.has(base)) continue;
    marks.set(base, mark);
    dropped.add(c);
  }
  if (dropped.size === 0) return;
  bucket.forEach((run, r) => {
    run.str = chars[r].map((c) => (dropped.has(c) ? '' : c.ch + (marks.get(c) ?? ''))).join('');
  });
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
  // Repetition only means something across a few pages; a bare page number
  // is recognisable on its own.
  const threshold = Math.max(3, Math.floor(pages.length * 0.5));
  const repeated =
    pages.length < 3 ? new Set<string>() : new Set([...counts.entries()].filter(([, n]) => n >= threshold).map(([k]) => k));
  let removed = 0;
  for (const page of pages) {
    // A running head often has a fixed half and a half that changes with the
    // chapter ("Study Notes ... Vector Analysis"). Once the fixed half shows it
    // is a running head, whatever shares its baseline goes with it.
    const heads = page.lines.filter((line) => inMargin(line, page) && repeated.has(key(line))).map((line) => line.y);
    page.lines = page.lines.filter((line) => {
      if (!inMargin(line, page)) return true;
      // A bare number in the margin is a page number whether it repeats or not.
      if (/^[ivxlcdm]{1,7}$|^\d{1,4}$|^[-–—\s]*\d{1,4}[-–—\s]*$/i.test(line.text)) {
        removed++;
        return false;
      }
      if (repeated.has(key(line)) || heads.some((y) => Math.abs(y - line.y) < line.size * 0.5)) {
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
  kind: 'paragraph' | 'heading' | 'list' | 'pagebreak' | 'image' | 'toc';
  text: string;
  /** Image blocks: the key of the picture. */
  src?: string;
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
    const figures = [...(page.figures ?? [])].sort((a, b) => a.top - b.top);
    // A contents page: its entries are lines of their own, and the page
    // numbers they point to belong to the printed document, not this one.
    const contents = page.lines.filter((line) => LEADER.test(line.text)).length >= 3;
    let nextFigure = 0;
    const writeFigure = () => {
      const figure = figures[nextFigure++];
      emit({ kind: 'image', text: figure.caption, indent: 0, src: figure.id });
    };
    for (const line of page.lines) {
      while (nextFigure < figures.length && figures[nextFigure].top <= line.y) writeFigure();
      // Vertical space is only meaningful between two lines of the same page
      // and the same column.
      const gapAbove = previousOnThisPage && previous && previous.column === line.column ? line.y - previous.y : null;
      const ratio = line.size / bodySize;
      const words = line.text.split(/\s+/).length;
      const short = isShort(line);
      const prevShort = previous === null || isShort(previous);
      const caps = line.text.length > 2 && line.text === line.text.toUpperCase() && /[A-Z]{2}/.test(line.text);
      const airAbove = gapAbove === null || gapAbove > lineGap * 1.25;

      if (contents && ratio < 1.12) {
        // The number at the end of an entry, pushed out to the margin.
        if (/^\d{1,4}$/.test(line.text) && previous !== null && previousOnThisPage && Math.abs(previous.y - line.y) < line.size * 0.5) continue;
        const entry = line.text.replace(LEADER, '').replace(/\s+\d{1,4}$/, '').trim();
        const depth = Math.max(0, Math.round((line.x0 - bodyLeft) / (bodySize * 1.5)));
        emit({ kind: 'toc', text: entry, indent: line.x0, level: depth });
        previous = line;
        previousOnThisPage = true;
        continue;
      }

      // Headings: bigger type, a line shouted in capitals, or a short line in
      // slightly larger type standing on its own with space above it.
      // A line set wholly in bold, standing on its own, is a heading at body
      // size: "Q3. Define the del operator." at the top of a box.
      const boldLine =
        (line.bold ?? 0) >= 0.9 && ratio >= 0.95 && words >= 2 && line.math < 0.3 && (airAbove || prevShort || previous === null) && !/[,;]$/.test(line.text);
      if (
        opts.detectHeadings &&
        words <= 18 &&
        (ratio >= 1.12 || boldLine || (caps && short && ratio >= 0.95) || (ratio >= 1.03 && short && airAbove && !/[.!?,;]$/.test(line.text)))
      ) {
        const level = ratio >= 1.45 ? 1 : ratio >= 1.2 ? 2 : 3;
        // A heading too long for one line carries on under itself.
        const last = blocks[blocks.length - 1];
        if (
          pending === null &&
          last?.kind === 'heading' &&
          last.level === level &&
          previous !== null &&
          previousOnThisPage &&
          gapAbove !== null &&
          gapAbove < lineGap * 1.3 &&
          Math.abs(previous.size - line.size) < line.size * 0.05 &&
          !/[.!?:]$/.test(previous.text)
        ) {
          last.text = stripTrailingDot(`${last.text} ${line.text}`);
        } else {
          emit({ kind: 'heading', text: stripTrailingDot(line.text), indent: line.x0, level });
        }
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
    while (nextFigure < figures.length) writeFigure();
  }
  flush();

  markIndentedLists(blocks, bodyLeft, bodySize);

  const out = blocks.map((b) => {
    if (b.kind === 'toc') return `${'    '.repeat(Math.min(3, b.level))}${b.text}`;
    if (b.kind === 'heading') return `${'#'.repeat(Math.min(3, Math.max(1, b.level)))} ${b.text}`;
    if (b.kind === 'list') return `${b.marker} ${b.text}`;
    // Brackets inside a caption would close the markup early.
    if (b.kind === 'image') return `![${b.text.replace(/[[\]()]/g, ' ').trim()}](${b.src ?? ''})`;
    return b.text;
  });
  // The entries of a contents list are written one under another.
  return out
    .map((text, i) => (i > 0 && blocks[i].kind === 'toc' && blocks[i - 1].kind === 'toc' ? `\n${text}` : `\n\n${text}`))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A contents entry's dot leader and the page number after it. */
const LEADER = /\s*(?:\.\s?){4,}\s*\d{0,4}\s*$/;

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
