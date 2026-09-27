import { describe, expect, it } from 'vitest';
import { absorbText, findFigureBoxes, type Box } from '../src/import/figures';
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
  return { y, x0, x1, size: BODY, text, column: 0 };
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
