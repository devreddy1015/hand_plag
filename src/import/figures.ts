/**
 * Finding the figures on a page.
 *
 * A PDF does not say "this is a diagram". It says: draw these strokes, paint
 * this image, set this text. So a figure has to be found the way a reader
 * finds one — as a block of drawn material that is not part of the running
 * text — and then given back everything that belongs to it: its axis labels,
 * its legend, and the caption sitting underneath.
 *
 * Nothing here touches a canvas or a PDF. It works on a grid of "something is
 * drawn in this cell" flags and on the lines of text already recovered, so it
 * can be tested on its own.
 */
import type { Line } from './reflow';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigureLimits {
  /** Size of one grid cell, in page units. */
  cell: number;
  pageWidth: number;
  pageHeight: number;
  /** Ignore anything smaller than this in either direction. */
  minSize: number;
  /**
   * Cells to spread the drawing by before looking for connected blocks. A
   * chart is drawn around its own labels, and masking the labels out leaves
   * holes; spreading the drawing closes them again. Each box is still measured
   * from the drawing itself, so this affects what joins up, never the extent.
   */
  spread?: number;
  /**
   * Blocks side by side in one row join up across a gap this wide: the boxes
   * of a flowchart, with the arrows between them drawn thinner than the
   * boxes, are one figure.
   */
  rowGap?: number;
}

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;

/** A connected block of drawing, and how much of its box it actually fills. */
interface Blob {
  box: Box;
  /** Cells with something drawn in them. */
  filled: number;
}

function density(blob: Blob, cell: number): number {
  const cells = Math.max(1, (blob.box.width / cell) * (blob.box.height / cell));
  return blob.filled / cells;
}

/**
 * Connected blocks of drawn material, as bounding boxes in page units.
 *
 * `grid` is row-major, one byte per cell, non-zero where something is drawn.
 */
export function findFigureBoxes(grid: Uint8Array, cols: number, rows: number, limits: FigureLimits): Box[] {
  const spread = Math.max(0, Math.round(limits.spread ?? 0));
  const work = spread > 0 ? dilate(grid, cols, rows, spread) : grid;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  /** Every block of drawing, before deciding which of them are figures. */
  const blobs: Blob[] = [];

  for (let start = 0; start < grid.length; start++) {
    if (work[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    let minC = cols;
    let maxC = -1;
    let minR = rows;
    let maxR = -1;
    let filled = 0;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const c = index % cols;
      const r = (index - c) / cols;
      // The block is walked over the spread copy, but measured from the
      // drawing itself, so spreading never inflates a figure.
      if (grid[index] === 1) {
        filled++;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
      // Eight-connected: a dashed leader line should not split a figure in two.
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          if (work[next] === 0 || seen[next] === 1) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }

    // A single speck is dust, not part of anything.
    if (maxC < 0 || filled < 2) continue;
    blobs.push({
      box: {
        x: minC * limits.cell,
        y: minR * limits.cell,
        width: (maxC - minC + 1) * limits.cell,
        height: (maxR - minR + 1) * limits.cell,
      },
      filled,
    });
  }

  // Join the parts up first and judge what they add up to afterwards: the box
  // round one label, the arrow beside it and the circle it points at are each
  // too small to be a figure, and together they are one.
  const joined = merge(blobs, limits.cell * 3);
  return (limits.rowGap ? mergeRows(joined, limits.rowGap) : joined)
    .filter((blob) => keep(blob.box, density(blob, limits.cell), limits))
    .map((blob) => blob.box)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Spread every drawn cell out by `radius` cells, so near neighbours join up. */
function dilate(grid: Uint8Array, cols: number, rows: number, radius: number): Uint8Array {
  // Two passes of a one-dimensional spread: the same result, far less work.
  const wide = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const row = r * cols;
    for (let c = 0; c < cols; c++) {
      if (grid[row + c] === 0) continue;
      for (let d = -radius; d <= radius; d++) {
        const nc = c + d;
        if (nc >= 0 && nc < cols) wide[row + nc] = 1;
      }
    }
  }
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (wide[r * cols + c] === 0) continue;
      for (let d = -radius; d <= radius; d++) {
        const nr = r + d;
        if (nr >= 0 && nr < rows) out[nr * cols + c] = 1;
      }
    }
  }
  return out;
}

/** Is this block of marks a figure, or is it page furniture? */
function keep(box: Box, density: number, limits: FigureLimits): boolean {
  if (box.width < limits.minSize || box.height < limits.minSize) return false;
  // A rule or a running line across the page is not a figure.
  if (box.height < limits.minSize * 0.6 && box.width > limits.pageWidth * 0.5) return false;
  if (box.width < limits.minSize * 0.6 && box.height > limits.pageHeight * 0.5) return false;
  // A border drawn round the whole sheet is not a figure either.
  if (box.width > limits.pageWidth * 0.92 && box.height > limits.pageHeight * 0.85) return false;
  // Scattered specks: a few marks spread over a wide box.
  return density >= 0.035;
}

/** Join blocks that touch or nearly touch, until nothing more can be joined. */
function merge(blobs: Blob[], gap: number): Blob[] {
  const out = [...blobs];
  let joined = true;
  while (joined) {
    joined = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!near(out[i].box, out[j].box, gap)) continue;
        out[i] = { box: union(out[i].box, out[j].box), filled: out[i].filled + out[j].filled };
        out.splice(j, 1);
        joined = true;
        break outer;
      }
    }
  }
  return out;
}

/**
 * Join blocks that share a row — most of the height of the smaller one lies
 * alongside the other — and stand within `gap` of each other.
 */
function mergeRows(blobs: Blob[], gap: number): Blob[] {
  const out = [...blobs];
  let joined = true;
  while (joined) {
    joined = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i].box;
        const b = out[j].box;
        const shared = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
        if (shared < Math.min(a.height, b.height) * 0.5) continue;
        const apart = Math.max(a.x, b.x) - Math.min(right(a), right(b));
        if (apart > gap) continue;
        out[i] = { box: union(a, b), filled: out[i].filled + out[j].filled };
        out.splice(j, 1);
        joined = true;
        break outer;
      }
    }
  }
  return out;
}

function near(a: Box, b: Box, gap: number): boolean {
  return a.x - gap < right(b) && b.x - gap < right(a) && a.y - gap < bottom(b) && b.y - gap < bottom(a);
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
}

/** The space a box is allowed to occupy, in page coordinates. */
export interface Room {
  /** The box may not start above this, nor end below `bottom`. */
  top: number;
  bottom: number;
  /** How far it may spread left and right. */
  sideways: number;
}

/**
 * The band between the lines above and below a box. A box measured from glyph
 * positions can already overlap its neighbours, so this is a boundary to be
 * held to, not merely a budget to grow within.
 */
export function roomAround(box: Box, lines: Line[], part: Set<Line>, most = 9): Room {
  const middle = box.y + box.height / 2;
  let top = box.y - most;
  let floor = bottom(box) + most;
  for (const line of lines) {
    if (part.has(line)) continue;
    const head = line.y - line.size * 1.05;
    const foot = line.y + line.size * 0.35;
    if (foot <= middle) top = Math.max(top, foot + 0.5);
    else if (head >= middle) floor = Math.min(floor, head - 0.5);
  }
  return { top, bottom: Math.max(top + 1, floor), sideways: 4 };
}

/**
 * Fit a box to the ink inside the room it has.
 *
 * A box measured from where the glyphs sit is the wrong size for mathematics:
 * a fraction rule, a radical or a tall bracket reaches past it, while the
 * first attempt may also overlap the line above. So clamp it to the room, then
 * walk each edge outwards while there is still something drawn. `dark` answers
 * whether anything is drawn in a strip of the page.
 */
export function growToInk(box: Box, dark: (x: number, y: number, w: number, h: number) => boolean, room: Room, step = 0.5): Box {
  let x = box.x;
  let x1 = right(box);
  let y = Math.max(box.y, room.top);
  let y1 = Math.min(bottom(box), room.bottom);
  if (y1 <= y) y1 = y + step;

  while (y - step >= room.top && dark(x, y - step, x1 - x, step)) y -= step;
  while (y1 + step <= room.bottom && dark(x, y1, x1 - x, step)) y1 += step;
  for (let n = 0; n < room.sideways / step && dark(x - step, y, step, y1 - y); n++) x -= step;
  for (let n = 0; n < room.sideways / step && dark(x1, y, step, y1 - y); n++) x1 += step;
  return { x, y, width: x1 - x, height: y1 - y };
}

/** What a caption starts with, in the documents people actually hand in. */
const CAPTION = /^\s*(fig(?:ure|\.)?|table|chart|diagram|graph|plate|scheme|exhibit|image|photo)\b[\s.:—–-]*\d*/i;

export interface Figure {
  box: Box;
  caption: string;
}

export interface AbsorbResult {
  figures: Figure[];
  /** Lines that belong to a figure and must not be written out as prose. */
  consumed: Set<Line>;
}

/**
 * Give each figure the text that belongs to it: labels inside it, and the
 * caption underneath. Those lines are then not written out as if they were
 * sentences, which is what makes an imported chart readable rather than a
 * scattering of stray words.
 */
export function absorbText(boxes: Box[], lines: Line[], bodySize: number, bodyWidth = Infinity): AbsorbResult {
  const consumed = new Set<Line>();
  const figures: Figure[] = [];

  for (const start of boxes) {
    let box = { ...start };
    // Labels sitting inside the figure, or just over its edge.
    let grew = true;
    while (grew) {
      grew = false;
      for (const line of lines) {
        if (consumed.has(line)) continue;
        if (!inside(line, box, bodySize, bodyWidth) && !attached(line, box, bodySize, bodyWidth)) continue;
        consumed.add(line);
        box = union(box, { x: line.x0, y: line.y - bodySize, width: line.x1 - line.x0, height: bodySize * 1.3 });
        grew = true;
      }
    }

    // The caption: a line under the figure that says it is one, or failing
    // that a short line tucked directly beneath. A line that announces itself
    // as a caption wins even if something else sits closer.
    let caption = '';
    // Look a good way down: a caption can sit under a line of axis labels, a
    // key, or a note about units, all of which belong to the figure too.
    const candidates: Line[] = [];
    for (const line of lines) {
      if (consumed.has(line)) continue;
      const below = line.y - bottom(box);
      if (below < 0 || below > bodySize * 6) continue;
      if (line.x1 < box.x - bodySize * 2 || line.x0 > right(box) + bodySize * 2) continue;
      candidates.push(line);
    }
    candidates.sort((a, b) => a.y - b.y);
    const named = candidates.find((line) => CAPTION.test(line.text));
    // Anything between the drawing and its caption is part of the figure: a
    // label under an axis, a key, the units. Take it into the box so it is cut
    // out with the picture instead of being written as a stray line of prose.
    if (named) {
      for (const line of candidates) {
        if (line.y >= named.y || consumed.has(line)) continue;
        consumed.add(line);
        box = union(box, { x: line.x0, y: line.y - bodySize, width: line.x1 - line.x0, height: bodySize * 1.3 });
      }
    }
    // Without a named caption, only a short line tucked right under the
    // figure counts; anything further down is the next paragraph.
    const loose = candidates[0] && candidates[0].y - bottom(box) <= bodySize * 2.5 ? candidates[0] : undefined;
    const best = named ?? loose;
    if (best) {
      const short = best.x1 - best.x0 < Math.min(bodyWidth * 0.8, box.width * 1.3);
      if (named || (short && best.text.length < 160)) {
        caption = best.text;
        consumed.add(best);
        // A caption that runs to a second line keeps going.
        for (const line of candidates) {
          if (line === best || consumed.has(line)) continue;
          if (line.y > best.y && line.y - best.y < bodySize * 1.6 && line.x1 - line.x0 < bodyWidth * 0.8) {
            caption = `${caption} ${line.text}`;
            consumed.add(line);
          }
        }
      }
    }
    figures.push({ box, caption });
  }

  return { figures, consumed };
}

/**
 * A label standing just outside the drawing: the title over a chart, the
 * name of an axis beside it, the quantity an arrow points to. It is short, no
 * bigger than the running text, not a sentence, and lined up with the figure.
 */
function attached(line: Line, box: Box, bodySize: number, bodyWidth: number): boolean {
  const width = line.x1 - line.x0;
  if (width > Math.min(bodyWidth * 0.45, Math.max(box.width, bodySize * 6))) return false;
  if (line.size > bodySize * 1.08) return false;
  if (/[.!?;]$/.test(line.text) || line.text.split(/\s+/).length > 6 || CAPTION.test(line.text)) return false;
  const top = line.y - line.size;
  const foot = line.y + line.size * 0.3;
  const gapX = Math.max(0, box.x - line.x1, line.x0 - right(box));
  const gapY = Math.max(0, box.y - foot, top - bottom(box));
  if (gapX > bodySize * 1.6 || gapY > bodySize * 1.4) return false;
  // Above or below: its middle must be over the figure. Beside: level with it.
  const midX = (line.x0 + line.x1) / 2;
  const midY = line.y - line.size * 0.35;
  if (gapY > 0) return midX > box.x && midX < right(box);
  return midY > box.y && midY < bottom(box);
}

function inside(line: Line, box: Box, bodySize: number, bodyWidth: number): boolean {
  const pad = bodySize * 0.6;
  const midY = line.y - bodySize * 0.35;
  return (
    midY > box.y - pad &&
    midY < bottom(box) + pad &&
    line.x1 > box.x - pad &&
    line.x0 < right(box) + pad &&
    // A line set to the full measure of the page is body text, not a label,
    // however much of the figure it happens to cross.
    line.x1 - line.x0 < bodyWidth * 0.8
  );
}
