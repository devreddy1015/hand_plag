import { describe, expect, it } from 'vitest';
import { absorbText, findFigureBoxes, growToInk, roomAround, type Box } from '../src/import/figures';
import type { Line } from '../src/import/reflow';

const CELL = 10;

/** Build a cell grid from a picture of one: `#` is something drawn. */
function art(rows: string[]): { grid: Uint8Array; cols: number; rows: number } {
  const cols = Math.max(...rows.map((r) => r.length));
  const grid = new Uint8Array(cols * rows.length);
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] !== '.' && row[c] !== ' ') grid[r * cols + c] = 1;
  });
  return { grid, cols, rows: rows.length };
}

function boxes(rows: string[], minSize = 25): Box[] {
  const { grid, cols, rows: n } = art(rows);
  return findFigureBoxes(grid, cols, n, { cell: CELL, pageWidth: cols * CELL, pageHeight: n * CELL, minSize });
}

describe('findFigureBoxes', () => {
  it('finds a block of drawing and measures it in page units', () => {
    const found = boxes([
      '..........',
      '..####....',
      '..####....',
      '..####....',
      '..........',
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ x: 20, y: 10, width: 40, height: 30 });
  });

  it('joins the parts of one diagram that nearly touch', () => {
    const found = boxes([
      '..........',
      '..###.###.',
      '..###.###.',
      '..###.###.',
      '..........',
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].width).toBe(70);
  });

  it('keeps two diagrams that stand well apart', () => {
    const found = boxes([
      '###.......###',
      '###.......###',
      '###.......###',
      '.............',
      '.............',
    ]);
    expect(found).toHaveLength(2);
  });

  it('ignores a rule running across the page', () => {
    expect(boxes(['.........', '#########', '.........', '.........'])).toHaveLength(0);
  });

  it('ignores a line running down the page', () => {
    expect(boxes(['..#....', '..#....', '..#....', '..#....', '..#....', '..#....'])).toHaveLength(0);
  });

  it('ignores a border drawn round the whole sheet', () => {
    expect(
      boxes([
        '##########',
        '#........#',
        '#........#',
        '#........#',
        '#........#',
        '##########',
      ]),
    ).toHaveLength(0);
  });

  it('ignores a mark too small to be a figure', () => {
    expect(boxes(['.......', '..##...', '..##...', '.......'])).toHaveLength(0);
  });

  it('ignores specks scattered over a wide area', () => {
    expect(
      boxes([
        '#.....#.....#',
        '.............',
        '.............',
        '#.....#.....#',
        '.............',
        '#.....#.....#',
      ]),
    ).toHaveLength(0);
  });
});

const BODY = 11;
function line(text: string, y: number, x0 = 60, x1 = 500): Line {
  return { y, x0, x1, size: BODY, text, column: 0, math: 0 };
}

describe('absorbText', () => {
  const figure: Box = { x: 100, y: 200, width: 300, height: 150 };

  it('takes in the labels drawn inside the figure', () => {
    const inside = line('Time (s)', 300, 180, 240);
    const body = line('An ordinary sentence of running text across the measure.', 500);
    const { figures, consumed } = absorbText([figure], [inside, body], BODY);
    expect(consumed.has(inside)).toBe(true);
    expect(consumed.has(body)).toBe(false);
    expect(figures[0].box.height).toBeGreaterThanOrEqual(150);
  });

  it('takes the caption from under the figure', () => {
    const caption = line('Figure 2. The Krebs cycle, in outline.', 362, 100, 380);
    const { figures, consumed } = absorbText([figure], [caption], BODY);
    expect(figures[0].caption).toBe('Figure 2. The Krebs cycle, in outline.');
    expect(consumed.has(caption)).toBe(true);
  });

  it('leaves the paragraph under a figure alone', () => {
    const body = line('This full-measure sentence carries on after the figure and is not a caption.', 362, 60, 533);
    const { figures, consumed } = absorbText([{ x: 100, y: 200, width: 200, height: 150 }], [body], BODY);
    expect(figures[0].caption).toBe('');
    expect(consumed.has(body)).toBe(false);
  });

  it('ignores a line too far below to belong to it', () => {
    const far = line('Figure 3. Something else entirely.', 420, 100, 380);
    const { figures, consumed } = absorbText([figure], [far], BODY);
    expect(figures[0].caption).toBe('');
    expect(consumed.has(far)).toBe(false);
  });
});

describe('roomAround and growToInk', () => {
  const above = line('The line of prose above.', 100, 60, 400);
  const below = line('The line of prose below.', 200, 60, 400);
  const box: Box = { x: 150, y: 120, width: 200, height: 40 };

  it('measures the band between the lines around it', () => {
    // A generous allowance, so the lines are what bind rather than the cap.
    const room = roomAround(box, [above, below], new Set(), 40);
    expect(room.top).toBeCloseTo(100 + BODY * 0.35 + 0.5, 5);
    expect(room.bottom).toBeCloseTo(200 - BODY * 1.05 - 0.5, 5);
  });

  it('never allows more growth than it is asked to', () => {
    const room = roomAround(box, [above, below], new Set(), 5);
    expect(room.top).toBe(box.y - 5);
    expect(room.bottom).toBe(box.y + box.height + 5);
  });

  it('ignores the lines that are part of the thing being measured', () => {
    const room = roomAround(box, [above, below], new Set([above, below]));
    expect(room.top).toBe(box.y - 9);
    expect(room.bottom).toBe(box.y + box.height + 9);
  });

  /** Ink everywhere inside this rectangle, and nowhere else. */
  const inkIn = (r: Box) => (x: number, y: number, w: number, h: number) =>
    x < r.x + r.width && r.x < x + w && y < r.y + r.height && r.y < y + h;

  it('grows a box until it stops touching ink', () => {
    const ink = { x: 140, y: 110, width: 220, height: 60 };
    const grown = growToInk({ x: 150, y: 120, width: 200, height: 40 }, inkIn(ink), { top: 100, bottom: 200, sideways: 20 });
    expect(grown.y).toBeLessThanOrEqual(110.5);
    expect(grown.y + grown.height).toBeGreaterThanOrEqual(169.5);
    expect(grown.x).toBeLessThanOrEqual(140.5);
  });

  it('never grows past the room it has', () => {
    const everywhere = () => true;
    const grown = growToInk({ x: 150, y: 120, width: 200, height: 40 }, everywhere, { top: 115, bottom: 165, sideways: 3 });
    expect(grown.y).toBeGreaterThanOrEqual(115);
    expect(grown.y + grown.height).toBeLessThanOrEqual(165);
  });

  it('pulls a box back when it already overlaps the line above', () => {
    // The box starts inside the line above; the room is the boundary.
    const grown = growToInk({ x: 150, y: 95, width: 200, height: 70 }, () => false, roomAround(box, [above, below], new Set()));
    expect(grown.y).toBeGreaterThanOrEqual(100 + BODY * 0.35);
  });
});

describe('labels standing just outside a figure', () => {
  const line = (text: string, x0: number, x1: number, y: number, size = 10): Line => ({ text, x0, x1, y, size, column: 0, math: 0 });

  it('takes a short label just above the drawing into it', () => {
    const box = { x: 100, y: 200, width: 200, height: 100 };
    const lines = [line('2 ATP', 180, 215, 190), line('This is the paragraph after the figure, which runs on.', 60, 540, 360)];
    const { figures, consumed } = absorbText([box], lines, 10, 480);
    expect(consumed.has(lines[0])).toBe(true);
    expect(consumed.has(lines[1])).toBe(false);
    expect(figures[0].box.y).toBeLessThan(190);
  });

  it('takes the name of an axis standing beside it', () => {
    const box = { x: 120, y: 200, width: 200, height: 100 };
    const lines = [line('ATP', 95, 112, 230)];
    const { consumed } = absorbText([box], lines, 10, 480);
    expect(consumed.has(lines[0])).toBe(true);
  });

  it('leaves the end of a sentence above a figure where it is', () => {
    const box = { x: 100, y: 200, width: 200, height: 100 };
    const lines = [line('rather than all at once.', 150, 260, 188)];
    const { consumed } = absorbText([box], lines, 10, 480);
    expect(consumed.has(lines[0])).toBe(false);
  });
});
