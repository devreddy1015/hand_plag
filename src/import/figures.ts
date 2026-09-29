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

/**
 * Clear the boxes drawn round running text: a shaded panel, a question box
 * with a coloured title bar, a frame round a theorem. They are furniture —
 * the words inside are the document — but to a search for blocks of drawing
 * a frame is one big block, and everything written in it would be cut out as
 * a picture and copied at a third of the size.
 *
 * A frame is a block that runs down both sides of its box and along most of
 * the top and bottom, with lines of text set across it. Its sides, its title
 * and footer bars, and any rule across it are cleared from `grid`; whatever
 * is drawn inside — an equation's rules, a diagram — stays to be found in its
 * own right. `texts` are the lines of text on the page, in the grid's units.
 * Returns the frames that were cleared.
 */
export function clearFrames(grid: Uint8Array, cols: number, rows: number, cell: number, texts: Box[]): Box[] {
  const label = new Int32Array(cols * rows).fill(-1);
  const stack: number[] = [];
  const cleared: Box[] = [];
  const parts: Part[] = [];

  for (let start = 0; start < grid.length; start++) {
    if (grid[start] === 0 || label[start] !== -1) continue;
    const part: Part = { id: start, members: [], minC: cols, maxC: -1, minR: rows, maxR: -1, bridged: 0 };
    label[start] = start;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      part.members.push(index);
      const c = index % cols;
      const r = (index - c) / cols;
      part.minC = Math.min(part.minC, c);
      part.maxC = Math.max(part.maxC, c);
      part.minR = Math.min(part.minR, r);
      part.maxR = Math.max(part.maxR, r);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc;
          const nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          if (grid[next] === 0 || label[next] !== -1) continue;
          label[next] = start;
          stack.push(next);
        }
      }
    }
    parts.push(part);
  }

  // Words set close under the top of a small frame and over its bottom are
  // cut out of both edges at once, and the frame falls in two: a "[" and a
  // "]" on the same rows. Put the halves back together.
  const owns = (part: Part, r: number, c: number) => label[r * cols + c] === part.id;
  const edged = (part: Part) => {
    let top = 0;
    let foot = 0;
    for (let c = part.minC; c <= part.maxC; c++) {
      if (owns(part, part.minR, c) || owns(part, part.minR + 1, c)) top++;
      if (owns(part, part.maxR, c) || owns(part, part.maxR - 1, c)) foot++;
    }
    const w = part.maxC - part.minC + 1;
    return Math.max(top, foot) >= w * 0.8 && Math.min(top, foot) >= w * 0.4;
  };
  const side = (part: Part, c0: number) => {
    let n = 0;
    for (let r = part.minR; r <= part.maxR; r++) if (owns(part, r, c0) || owns(part, r, c0 + 1)) n++;
    return n >= (part.maxR - part.minR + 1) * 0.85;
  };
  parts.sort((a, b) => a.minC - b.minC);
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (a.maxR - a.minR < 3 || !edged(a)) continue;
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j];
      if (Math.abs(a.minR - b.minR) > 1 || Math.abs(a.maxR - b.maxR) > 1) continue;
      const gap = b.minC - a.maxC - 1;
      const span = a.maxC - a.minC + 1 + (b.maxC - b.minC + 1);
      if (gap < -2 || gap > span * 1.5 || !edged(b)) continue;
      // Two whole frames side by side stay two frames. (One facing side may
      // be a tall bracket of the equation inside, touching top and bottom.)
      if (side(a, a.maxC - 1) && side(b, b.minC)) continue;
      for (const index of b.members) label[index] = a.id;
      a.members.push(...b.members);
      a.bridged += Math.max(0, gap);
      a.maxC = Math.max(a.maxC, b.maxC);
      a.minR = Math.min(a.minR, b.minR);
      a.maxR = Math.max(a.maxR, b.maxR);
      parts.splice(j, 1);
      j--;
    }
  }

  for (const part of parts) {
    const { id, members, minC, maxC, minR, maxR } = part;
    const w = maxC - minC + 1;
    const h = maxR - minR + 1;
    if (w < 8 || h < 4) continue;
    const mine = (r: number, c: number) => label[r * cols + c] === id;
    const band = (r: number, c0: number, c1: number) => {
      for (let c = c0; c <= c1; c++) if (mine(r, c)) return true;
      return false;
    };
    // How much of each side is drawn: a frame has all four.
    let left = 0;
    let rightSide = 0;
    for (let r = minR; r <= maxR; r++) {
      if (band(r, minC, minC + 1)) left++;
      if (band(r, maxC - 1, maxC)) rightSide++;
    }
    let top = part.bridged;
    let foot = part.bridged;
    for (let c = minC; c <= maxC; c++) {
      if (mine(minR, c) || mine(minR + 1, c)) top++;
      if (mine(maxR, c) || mine(maxR - 1, c)) foot++;
    }
    // The words of a title bar are cut out of it, so its top may be broken —
    // almost gone, under a title of two long lines — while its sides and
    // the other edge still run the whole way.
    const sides = Math.min(left, rightSide) / h;
    if (sides < 0.85 || Math.max(top, foot) < w * 0.6 || (Math.min(top, foot) < w * 0.1 && sides < 0.95)) continue;

    // Only a frame round writing is furniture; a box round a chart is part
    // of the chart. A line of text set across most of it says which this is.
    // Clearing the frame of a framed figure costs only the frame: whatever
    // is drawn inside is still found.
    const box = { x: minC * cell, y: minR * cell, width: w * cell, height: h * cell };
    const within = texts.filter((t) => {
      const midY = t.y + t.height / 2;
      return midY > box.y && midY < bottom(box) && t.x >= box.x - cell && right(t) <= right(box) + cell;
    });
    // A long, bare rectangle — nothing drawn but its own four sides — round
    // even a short line of text is a frame too: the box round a result. A
    // square round a label or two is a drawing.
    let rim = 0;
    for (const index of members) {
      const c = index % cols;
      const r = (index - c) / cols;
      if (c <= minC + 1 || c >= maxC - 1 || r <= minR + 1 || r >= maxR - 1) rim++;
    }
    const bare = rim >= members.length * 0.9 && w >= h * 2.5;
    if (!within.some((t) => t.width >= box.width * 0.45) && !(bare && within.length > 0)) continue;

    // Rows filled across a good part of the box are its bars and rules; the
    // cells at its very edge are its sides.
    // A title bar has its words cut out of it, so it counts from less.
    const clearRow = new Uint8Array(h);
    const fill = (r: number) => {
      let filled = 0;
      for (let c = minC; c <= maxC; c++) if (mine(r, c)) filled++;
      return filled / w;
    };
    for (let r = minR; r <= maxR; r++) if (fill(r) >= 0.3) clearRow[r - minR] = 1;
    // The rows of a bar go with the edge or the rule they run on from: the
    // title bar of the next box down, joined on to this one, too.
    for (let grew = true; grew; ) {
      grew = false;
      for (let r = minR; r <= maxR; r++) {
        if (clearRow[r - minR] === 1 || fill(r) < 0.1) continue;
        const next = (r > minR && clearRow[r - minR - 1] === 1) || (r < maxR && clearRow[r - minR + 1] === 1);
        const edge = r === minR || r === maxR;
        if (next || edge) {
          clearRow[r - minR] = 1;
          grew = true;
        }
      }
    }
    for (const index of members) {
      const c = index % cols;
      const r = (index - c) / cols;
      const edge = c <= minC + 1 || c >= maxC - 1 || r <= minR + 1 || r >= maxR - 1;
      if (edge || clearRow[r - minR] === 1) grid[index] = 0;
    }
    cleared.push(box);
  }
  return cleared;
}

/** A connected block of drawing, by its cells. */
interface Part {
  id: number;
  members: number[];
  minC: number;
  maxC: number;
  minR: number;
  maxR: number;
  /** Columns where its top and bottom were cut away under words, now bridged. */
  bridged: number;
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
  // A number line or a strip of material is long and low, and a figure still.
  const small = Math.min(box.width, box.height);
  const large = Math.max(box.width, box.height);
  // So is an axis standing on its own with the charges marked along it: tall
  // and thin, but well short of a rule down the page.
  const upright = box.height >= limits.minSize * 3 && box.width >= limits.minSize * 0.1 && box.height <= limits.pageHeight * 0.5;
  if (!upright && (small < limits.minSize * 0.5 || large < limits.minSize * (small < limits.minSize ? 1.5 : 1))) return false;
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
    // Only what stands over or under the box hems it in, not a label beside it.
    if (line.x1 < box.x || line.x0 > right(box)) continue;
    const head = line.y - line.size * 1.05;
    const foot = line.y + line.size * 0.35;
    if (foot <= middle) top = Math.max(top, foot + 0.5);
    else if (head >= middle) floor = Math.min(floor, head - 0.5);
  }
  // Never so tight that the box's own lines, standing in it, are cut off.
  for (const line of lines) {
    if (!part.has(line) || line.y - line.size * 0.8 >= bottom(box) || line.y + line.size * 0.25 <= box.y) continue;
    top = Math.min(top, line.y - line.size * 0.8);
    floor = Math.max(floor, line.y + line.size * 0.25);
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

/**
 * Tables, as boxes to cut out and copy like a figure. Written out line by
 * line a table falls apart into a list of loose words — "Property",
 * "Conductor", "Insulator" — so it is found instead: rows of three or more
 * pieces of text on one baseline, their pieces starting at the same few
 * places across the page, with the odd row that only continues a cell.
 */
export function findTables(lines: Line[], bodySize: number): { boxes: Box[]; consumed: Set<Line> } {
  const rows: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - line.y) < line.size * 0.5) row.push(line);
    else rows.push([line]);
  }
  const boxes: Box[] = [];
  const consumed = new Set<Line>();
  const leading = bodySize * 1.25;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length < 3) continue;
    const starts = rows[i].map((line) => line.x0);
    const at = (line: Line) => starts.some((x) => Math.abs(x - line.x0) < bodySize * 0.6);
    const left = Math.min(...starts);
    const reach = Math.max(...rows[i].map((line) => line.x1));
    const table = [rows[i]];
    let full = 1;
    for (let k = i + 1; k < rows.length; k++) {
      const row = rows[k];
      if (row[0].y - table[table.length - 1][0].y > leading * 2.4) break;
      if (!row.every(at)) break;
      // A line of prose back at the margin ends the table.
      if (row.length === 1 && Math.abs(row[0].x0 - left) < bodySize * 0.6 && row[0].x1 - row[0].x0 > (reach - left) * 0.5) break;
      table.push(row);
      if (row.length >= 2) full++;
    }
    if (table.length < 3 || full < 2) continue;
    const all = table.flat();
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const line of all) {
      x0 = Math.min(x0, line.x0);
      x1 = Math.max(x1, line.x1);
      consumed.add(line);
    }
    const top = table[0][0].y - table[0][0].size * 1.2;
    const last = table[table.length - 1][0];
    boxes.push({ x: x0 - bodySize * 0.3, y: top, width: x1 - x0 + bodySize * 0.6, height: last.y + last.size * 0.5 - top });
    i += table.length - 1;
  }
  return { boxes, consumed };
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
    // (An equation set under a figure is not its caption.)
    const loose = candidates[0] && candidates[0].y - bottom(box) <= bodySize * 2.5 && !candidates[0].text.includes('=') ? candidates[0] : undefined;
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
  // Above or below: its middle must be over the figure. Beside: level with
  // it. (A label may touch the edge it stands on, so judge by its middle.)
  const midX = (line.x0 + line.x1) / 2;
  const midY = line.y - line.size * 0.35;
  if ((midX > box.x && midX < right(box)) || (midY > box.y && midY < bottom(box))) return true;
  // Or at a corner, close in: the name at the tip of an arrow.
  return gapX < bodySize * 0.6 && gapY < bodySize * 0.6;
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
