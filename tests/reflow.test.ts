import { describe, expect, it } from 'vitest';
import { DEFAULT_PDF_OPTIONS, buildLines, reconstruct, type PageLines, type PdfOptions, type TextRun } from '../src/import/reflow';

const PAGE_H = 842;
const PAGE_W = 595;
const BODY = 11.5;
const LEAD = 18;

interface Spec {
  text: string;
  /** Baseline measured down from the top of the page. */
  y: number;
  x?: number;
  size?: number;
  /** Width in points; defaults to a full measure. */
  width?: number;
}

/** A positioned run, the way pdf.js reports one. */
function run(spec: Spec): TextRun {
  const size = spec.size ?? BODY;
  const x = spec.x ?? 63;
  return {
    str: spec.text,
    transform: [size, 0, 0, size, x, PAGE_H - spec.y],
    width: spec.width ?? 470,
    height: size,
  };
}

function page(index: number, specs: Spec[]): PageLines {
  return { index, width: PAGE_W, height: PAGE_H, lines: buildLines(specs.map(run), PAGE_H, PAGE_W) };
}

function text(pages: PageLines[], options: Partial<PdfOptions> = {}): string {
  return reconstruct(pages, { ...DEFAULT_PDF_OPTIONS, ...options }).text;
}

describe('buildLines', () => {
  it('groups runs onto the same line and spaces them apart', () => {
    const lines = buildLines(
      [
        run({ text: 'Hello', y: 100, x: 63, width: 30 }),
        run({ text: 'world', y: 100.4, x: 100, width: 32 }),
        run({ text: 'below', y: 118, x: 63, width: 30 }),
      ],
      PAGE_H,
      PAGE_W,
    );
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'below']);
    expect(lines[0].x1).toBeCloseTo(132);
  });

  it('keeps runs that already touch together', () => {
    const lines = buildLines([run({ text: 'foot', y: 100, x: 63, width: 20 }), run({ text: 'note', y: 100, x: 83, width: 20 })], PAGE_H, PAGE_W);
    expect(lines[0].text).toBe('footnote');
  });

  it('ignores text turned on its side', () => {
    const sideways: TextRun = { str: 'WATERMARK', transform: [0, 12, -12, 0, 300, 400], width: 100, height: 12 };
    expect(buildLines([sideways, run({ text: 'real text', y: 100 })], PAGE_H, PAGE_W).map((l) => l.text)).toEqual(['real text']);
  });
});

describe('paragraphs', () => {
  it('joins the lines of a paragraph and separates the next one', () => {
    const doc = page(0, [
      { text: 'The first paragraph runs across two lines of the measure', y: 100 },
      { text: 'and finishes here.', y: 100 + LEAD, width: 120 },
      { text: 'A second paragraph starts after a wider gap than the', y: 100 + LEAD * 2 + 10 },
      { text: 'leading between its own lines.', y: 100 + LEAD * 3 + 10, width: 180 },
    ]);
    expect(text([doc])).toBe(
      'The first paragraph runs across two lines of the measure and finishes here.\n\n' +
        'A second paragraph starts after a wider gap than the leading between its own lines.',
    );
  });

  it('carries a sentence across a page break', () => {
    const first = page(0, [
      { text: 'This sentence begins on one page and does not stop at the', y: 700 },
      { text: 'bottom of it, but carries on to the page after, without any', y: 700 + LEAD },
    ]);
    const second = page(1, [{ text: 'full stop in between.', y: 100, width: 110 }]);
    expect(text([first, second])).toBe(
      'This sentence begins on one page and does not stop at the bottom of it, but carries on to the page after, without any full stop in between.',
    );
  });

  it('starts a new paragraph on the next page when the last one ended', () => {
    const first = page(0, [
      { text: 'Some text set across the full measure of the page, ending', y: 660 },
      { text: 'on a finished thought, with a full stop.', y: 660 + LEAD, width: 200 },
    ]);
    const second = page(1, [{ text: 'A new thought begins here.', y: 100, width: 150 }]);
    expect(text([first, second]).split('\n\n')).toHaveLength(2);
  });

  it('puts a hyphenated word back together', () => {
    const doc = page(0, [
      { text: 'The complex is enormous, comprising three distinct en-', y: 100 },
      { text: 'zymes and five coenzymes.', y: 100 + LEAD, width: 140 },
    ]);
    expect(text([doc])).toBe('The complex is enormous, comprising three distinct enzymes and five coenzymes.');
  });

  it('inserts page breaks when they are asked for', () => {
    const pages = [page(0, [{ text: 'First page.', y: 100, width: 60 }]), page(1, [{ text: 'Second page.', y: 100, width: 70 }])];
    expect(text(pages, { keepPageBreaks: true })).toBe('First page.\n\n[[page]]\n\nSecond page.');
  });
});

describe('headings', () => {
  it('recovers a heading from the size of its type', () => {
    const doc = page(0, [
      { text: 'Cellular Respiration', y: 100, size: 21, width: 260 },
      { text: 'Every living cell needs a continuous supply of energy.', y: 130 },
    ]);
    expect(text([doc]).split('\n\n')[0]).toBe('# Cellular Respiration');
  });

  it('recovers a smaller heading from its size, length and the space above it', () => {
    const doc = page(0, [
      { text: 'Some ordinary body text that fills the whole measure.', y: 100 },
      { text: 'Why decarboxylation matters', y: 100 + LEAD * 2, size: 12.5, width: 170 },
      { text: 'The carbon dioxide released here is what the body exhales.', y: 100 + LEAD * 3 },
    ]);
    expect(text([doc]).split('\n\n')[1]).toBe('### Why decarboxylation matters');
  });

  it('recovers a heading shouted in capitals', () => {
    const doc = page(0, [
      { text: 'ABSTRACT', y: 100, width: 70 },
      { text: 'This paper describes a method for doing something useful.', y: 100 + LEAD },
    ]);
    expect(text([doc]).split('\n\n')[0]).toBe('### ABSTRACT');
  });

  it('leaves headings alone when asked to', () => {
    const doc = page(0, [
      { text: 'Cellular Respiration', y: 100, size: 21, width: 260 },
      { text: 'Every living cell needs a continuous supply of energy.', y: 130 },
    ]);
    expect(text([doc], { detectHeadings: false })).not.toContain('#');
  });
});

describe('lists', () => {
  it('keeps a numbered list numbered by its author', () => {
    const doc = page(0, [
      { text: 'The pathway is worth learning as a list of steps, because', y: 100 },
      { text: 'each one is examined on its own. Steps to follow:', y: 100 + LEAD, width: 230 },
      { text: '1. Phosphorylate the glucose.', y: 100 + LEAD * 2.4, x: 111, width: 160 },
      { text: '2. Split it in two.', y: 100 + LEAD * 3.6, x: 111, width: 120 },
    ]);
    const out = text([doc]).split('\n\n');
    expect(out[1]).toBe('1. Phosphorylate the glucose.');
    expect(out[2]).toBe('2. Split it in two.');
  });

  it('recovers a bulleted list whose bullets were drawn, not written', () => {
    const doc = page(0, [
      { text: 'The cycle has three things worth remembering, set out', y: 100 },
      { text: 'in the list below.', y: 100 + LEAD, width: 100 },
      { text: 'It turns twice for every molecule of glucose.', y: 100 + LEAD * 2.4, x: 111, width: 230 },
      { text: 'Its intermediates are drawn off for biosynthesis.', y: 100 + LEAD * 3.6, x: 111, width: 240 },
      { text: 'It cannot run without oxygen.', y: 100 + LEAD * 4.8, x: 111, width: 160 },
    ]);
    const out = text([doc]).split('\n\n');
    expect(out.slice(1)).toEqual([
      '- It turns twice for every molecule of glucose.',
      '- Its intermediates are drawn off for biosynthesis.',
      '- It cannot run without oxygen.',
    ]);
  });

  it('leaves a single indented block as a paragraph', () => {
    const doc = page(0, [
      { text: 'A line of ordinary text across the measure.', y: 100 },
      { text: 'One indented block, which is a quotation and not a list.', y: 100 + LEAD * 1.6, x: 111, width: 240 },
      { text: 'Back to ordinary text again.', y: 100 + LEAD * 3, width: 150 },
    ]);
    expect(text([doc])).not.toContain('- ');
  });
});

describe('running heads', () => {
  const body = (y: number) => ({ text: 'Body text that fills the measure of the page nicely.', y });
  // dropRunningHeads edits the pages it is handed, so each test gets its own.
  const pages = () =>
    [0, 1, 2, 3].map((i) =>
      page(i, [
        { text: `9/27/26, 1:03 PM Cellular Respiration — Unit 4 Notes`, y: 22, size: 8 },
        body(120),
        body(120 + LEAD),
        { text: `file:///tmp/source-doc.html ${i + 1}/4`, y: 820, size: 8 },
      ]),
    );

  it('drops the header and footer repeated on every page', () => {
    const out = text(pages());
    expect(out).not.toContain('Unit 4 Notes');
    expect(out).not.toContain('file:///tmp');
    expect(out).toContain('Body text');
  });

  it('keeps them when asked to', () => {
    expect(text(pages(), { dropRunningHeads: false })).toContain('Unit 4 Notes');
  });

  it('reports what it left out', () => {
    const { warnings } = reconstruct(pages(), DEFAULT_PDF_OPTIONS);
    expect(warnings.join(' ')).toMatch(/left out \d+ running/i);
  });
});

describe('figures', () => {
  it('writes a figure into the flow where it sits on the page', () => {
    const doc = page(0, [
      { text: 'A paragraph above the figure that runs the full measure.', y: 100 },
      { text: 'Another paragraph, well below the figure instead.', y: 400 },
    ]);
    doc.figures = [{ id: 'pdf-1-1', top: 200, bottom: 340, caption: 'Figure 1. A cycle.' }];
    const out = text([doc]).split('\n\n');
    expect(out[1]).toBe('![Figure 1. A cycle.](pdf-1-1)');
    expect(out[2]).toContain('Another paragraph');
  });

  it('writes a figure at the foot of the page after the text', () => {
    const doc = page(0, [{ text: 'All the text comes first on this page.', y: 100, width: 220 }]);
    doc.figures = [{ id: 'pdf-1-1', top: 500, bottom: 640, caption: '' }];
    expect(text([doc]).split('\n\n')[1]).toBe('![](pdf-1-1)');
  });

  it('keeps brackets out of the caption markup', () => {
    const doc = page(0, [{ text: 'Text.', y: 100, width: 40 }]);
    doc.figures = [{ id: 'pdf-1-1', top: 200, bottom: 300, caption: 'Figure 1 (a) [detail]' }];
    const markup = text([doc]).split('\n\n')[1];
    expect(markup).toMatch(/^!\[[^[\]()]*\]\(pdf-1-1\)$/);
    expect(markup).toContain('Figure 1');
    expect(markup).toContain('detail');
  });
});

describe('columns', () => {
  it('reads down one column before the other', () => {
    const left = (text: string, y: number) => ({ text, y, x: 50, width: 200 });
    const right = (text: string, y: number) => ({ text, y, x: 320, width: 200 });
    const specs: Spec[] = [];
    for (let i = 0; i < 8; i++) {
      specs.push(left(`left ${i}`, 100 + LEAD * i), right(`right ${i}`, 100 + LEAD * i));
    }
    const doc = page(0, specs);
    const out = text([doc]);
    expect(out.indexOf('left 7')).toBeLessThan(out.indexOf('right 0'));
    expect(out).not.toMatch(/left \d right/);
  });

  it('reads a full-width title before the columns under it', () => {
    const specs: Spec[] = [{ text: 'A Title Across The Whole Page', y: 60, x: 50, size: 18, width: 470 }];
    for (let i = 0; i < 8; i++) {
      specs.push({ text: `left ${i}`, y: 100 + LEAD * i, x: 50, width: 200 }, { text: `right ${i}`, y: 100 + LEAD * i, x: 320, width: 200 });
    }
    const out = text([page(0, specs)]);
    expect(out.indexOf('Title')).toBeLessThan(out.indexOf('left 0'));
  });
});
