import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, applyTemplate, layoutDocument, pageGeometry, type PageGeometry, type Settings } from '../src/engine';

/** Monospace-ish fake font: letters 10u wide, spaces 5u. */
const measure = (text: string) => {
  let w = 0;
  for (const ch of text) w += ch === ' ' ? 5 : 10;
  return w;
};

const FONT_PX = 20;

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

/** Lay out with the human touches off, so assertions can be exact. */
function layout(text: string, overrides: Partial<Settings> = {}) {
  const s = settings({ text, corrections: 0, lineFill: 0, markdown: false, ...overrides });
  return layoutDocument(text, (i) => pageGeometry(s, i), FONT_PX, s, measure);
}

const area = (geom: PageGeometry) => geom.areas[0];

const lorem = (words: number) =>
  Array.from({ length: words }, (_, i) => ['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]).join(' ');

const drawn = (doc: { pages: { glyphs: { text: string }[] }[] }) =>
  doc.pages.flatMap((p) => p.glyphs.map((g) => g.text)).join('');

describe('layoutDocument', () => {
  it('is deterministic for the same seed', () => {
    expect(layout(lorem(200)).pages).toEqual(layout(lorem(200)).pages);
  });

  it('changes with the seed', () => {
    const a = layout(lorem(50), { seed: 1 });
    const b = layout(lorem(50), { seed: 2 });
    expect(a.pages[0].glyphs[5]).not.toEqual(b.pages[0].glyphs[5]);
  });

  it('keeps every letter, in order', () => {
    const text = 'The quick brown fox\njumps over\n\nthe lazy dog.';
    expect(drawn(layout(text))).toBe(text.replace(/\s/g, ''));
  });

  it('wraps inside the text area', () => {
    const doc = layout(lorem(600));
    const { left, right } = area(doc.geometry);
    for (const page of doc.pages) {
      for (const g of page.glyphs) {
        expect(g.x).toBeGreaterThanOrEqual(left - 0.001);
        expect(g.x + 10 * g.scaleX).toBeLessThanOrEqual(right + 0.001);
      }
    }
  });

  it('flows onto more pages and keeps glyphs on the page', () => {
    const doc = layout(lorem(3000));
    expect(doc.pages.length).toBeGreaterThan(1);
    doc.pages.forEach((page, i) => {
      expect(page.index).toBe(i);
      expect(page.glyphs.length).toBeGreaterThan(0);
      for (const g of page.glyphs) {
        expect(g.y).toBeGreaterThan(0);
        expect(g.y).toBeLessThan(doc.geometry.height);
      }
    });
  });

  it('writes on the ruled lines and stays flat when messiness is zero', () => {
    const doc = layout('hello world\nsecond line', { messiness: 0, slant: 0 });
    const lines = area(doc.geometry).lines;
    const ys = [...new Set(doc.pages[0].glyphs.map((g) => g.y.toFixed(3)))].map(Number);
    expect(ys).toHaveLength(2);
    expect(ys[0]).toBeLessThan(lines[0]);
    expect(lines[0] - ys[0]).toBeLessThan(doc.geometry.spacing * 0.2);
    for (const g of doc.pages[0].glyphs) {
      expect(g.rotation).toBeCloseTo(0, 12);
      expect(g.skew).toBeCloseTo(0, 12);
      expect(g.scaleX).toBeCloseTo(1, 12);
      expect(g.scaleY).toBeCloseTo(1, 12);
    }
  });

  it('starts a new page at [[page]]', () => {
    const doc = layout('first\n[[page]]\nsecond');
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0].glyphs.map((g) => g.text).join('')).toBe('first');
    expect(doc.pages[1].glyphs.map((g) => g.text).join('')).toBe('second');
  });

  it('keeps blank lines', () => {
    const doc = layout('a\n\n\nb', { messiness: 0 });
    const [a, b] = doc.pages[0].glyphs;
    expect(b.y - a.y).toBeCloseTo(doc.geometry.spacing * 3, 1);
  });

  it('splits a word longer than a line', () => {
    const doc = layout('x'.repeat(400));
    const ys = new Set(doc.pages[0].glyphs.map((g) => Math.round(g.y / doc.geometry.spacing)));
    expect(ys.size).toBeGreaterThan(1);
    for (const g of doc.pages[0].glyphs) expect(g.x).toBeLessThanOrEqual(area(doc.geometry).right);
  });

  it('wraps Chinese text without spaces', () => {
    const doc = layout('字'.repeat(300));
    const lines = new Set(doc.pages[0].glyphs.map((g) => Math.round(g.y / doc.geometry.spacing)));
    expect(lines.size).toBeGreaterThan(1);
  });

  it('lays right-to-left paragraphs from the right margin', () => {
    const doc = layout('שלום עולם', { messiness: 0 });
    const [first, second] = doc.pages[0].glyphs;
    expect(first.text).toBe('שלום');
    expect(first.x).toBeGreaterThan(second.x);
    expect(first.x + 40).toBeCloseTo(area(doc.geometry).right, 5);
  });

  it('does not reshuffle earlier paragraphs when a later one is edited', () => {
    const a = layout('Paragraph one stays put.\nSecond paragraph.');
    const b = layout('Paragraph one stays put.\nSecond paragraph, edited.');
    const firstLine = (d: typeof a) => d.pages[0].glyphs.slice(0, 21);
    expect(firstLine(a)).toEqual(firstLine(b));
  });

  it('always returns at least one page', () => {
    expect(layout('').pages).toHaveLength(1);
  });
});

describe('structure', () => {
  it('writes headings larger and underlines them', () => {
    const doc = layout('# Title\nbody text', { markdown: true, messiness: 0 });
    const title = doc.pages[0].glyphs.filter((g) => 'Title'.includes(g.text));
    const body = doc.pages[0].glyphs.find((g) => g.text === 'b')!;
    expect(title[0].scaleY).toBeGreaterThan(body.scaleY * 1.3);
    expect(doc.pages[0].strokes.length).toBeGreaterThan(0);
  });

  it('gives a big heading two rule slots and a line of air above', () => {
    const doc = layout('intro\n# Title\nbody', { markdown: true, messiness: 0 });
    const spacing = doc.geometry.spacing;
    const ys = [...new Set(doc.pages[0].glyphs.map((g) => Math.round(g.y / spacing)))];
    // intro, (blank), heading on the second of its two slots, body.
    expect(ys[1] - ys[0]).toBe(3);
  });

  it('marks a bullet list with a drawn dab and a hanging indent', () => {
    const doc = layout('- first item\n- second item', { markdown: true, messiness: 0 });
    expect(doc.pages[0].strokes.filter((s) => s.points.length === 1)).toHaveLength(2);
    const left = Math.min(...doc.pages[0].glyphs.map((g) => g.x));
    expect(left).toBeGreaterThan(area(doc.geometry).left);
  });

  it('keeps the author’s own list numbers', () => {
    const doc = layout('3. third\n4. fourth', { markdown: true });
    expect(drawn(doc)).toBe('3.third4.fourth');
  });

  it('presses harder on bold and leans further on italic', () => {
    const doc = layout('plain **bold** _slanted_', { markdown: true, messiness: 0 });
    const glyphs = doc.pages[0].glyphs;
    const plain = glyphs.find((g) => g.text === 'p')!;
    const bold = glyphs.find((g) => g.text === 'b')!;
    const italic = glyphs.find((g) => g.text === 's')!;
    expect(bold.pressure).toBeGreaterThan(plain.pressure);
    expect(bold.scaleY).toBeGreaterThan(plain.scaleY);
    expect(Math.abs(italic.skew)).toBeGreaterThan(Math.abs(plain.skew) + 0.1);
    expect(drawn(doc)).toBe('plainboldslanted');
  });

  it('rules off a divider without writing any letters', () => {
    const doc = layout('above\n---\nbelow', { markdown: true });
    expect(drawn(doc)).toBe('abovebelow');
    expect(doc.pages[0].strokes.length).toBe(1);
  });

  it('ignores markup when markdown reading is off', () => {
    const doc = layout('# not a heading', { markdown: false });
    expect(drawn(doc)).toBe('#notaheading');
  });
});

describe('filling the line', () => {
  it('fits more words per line when the writer crams', () => {
    const text = lorem(400);
    const loose = layout(text, { lineFill: 0 });
    const tight = layout(text, { lineFill: 1 });
    const lines = (d: typeof loose) => new Set(d.pages.flatMap((p) => p.glyphs.map((g) => `${p.index}:${g.y.toFixed(1)}`))).size;
    expect(lines(tight)).toBeLessThanOrEqual(lines(loose));
  });

  it('hyphenates a long word rather than leave a hole', () => {
    const text = Array.from({ length: 40 }, () => 'extraordinarily complicated').join(' ');
    const doc = layout(text, { lineFill: 1 });
    const letters = drawn(doc);
    expect(letters).toContain('-');
    expect(letters.replace(/-/g, '')).toBe(text.replace(/\s/g, ''));
  });
});

describe('human corrections', () => {
  it('adds none at all when turned off', () => {
    const doc = layout(lorem(500), { corrections: 0 });
    expect(doc.pages.flatMap((p) => p.strokes)).toHaveLength(0);
  });

  it('crosses out a false start and writes the word again', () => {
    const doc = layout(lorem(500), { corrections: 1 });
    const strokes = doc.pages.flatMap((p) => p.strokes);
    expect(strokes.length).toBeGreaterThan(0);
    // Every word still appears in full, in order, whatever was crossed out.
    const words = drawn(doc);
    expect(words).toContain('alphabetagammadeltaepsilon');
  });
});

describe('page furniture', () => {
  it('fills the first column before the second', () => {
    const s = settings({ text: lorem(400), corrections: 0, lineFill: 0 });
    s.features = { ...s.features, columns: 2, columnDivider: true };
    const doc = layoutDocument(s.text, (i) => pageGeometry(s, i), FONT_PX, s, measure);
    const geom = doc.geometry;
    expect(geom.areas).toHaveLength(2);
    const first = doc.pages[0].glyphs[0];
    expect(first.x).toBeLessThan(geom.areas[0].right);
    const last = doc.pages[0].glyphs[doc.pages[0].glyphs.length - 1];
    expect(last.x).toBeGreaterThanOrEqual(geom.areas[1].left - 1);
  });

  it('mirrors the binding on alternate pages', () => {
    const s = settings({ text: lorem(1200), corrections: 0 });
    s.features = { ...s.features, mirrorEvenPages: true };
    s.margins = { ...s.margins, left: 30, right: 10 };
    const doc = layoutDocument(s.text, (i) => pageGeometry(s, i), FONT_PX, s, measure);
    expect(doc.pages.length).toBeGreaterThan(1);
    expect(doc.geometryOf(0).areas[0].left).toBeGreaterThan(doc.geometryOf(1).areas[0].left);
    expect(doc.geometryOf(0).bindingSide).toBe('left');
    expect(doc.geometryOf(1).bindingSide).toBe('right');
  });

  it('writes the page number by hand above the text', () => {
    const s = settings({ text: lorem(1200), corrections: 0 });
    s.features = { ...s.features, pageNumber: 'handwritten' };
    const doc = layoutDocument(s.text, (i) => pageGeometry(s, i), FONT_PX, s, measure);
    const second = doc.pages[1];
    const number = second.glyphs[second.glyphs.length - 1];
    expect(number.text).toBe('2');
    expect(number.y).toBeLessThan(doc.geometryOf(1).areas[0].lines[0]);
  });
});

describe('pageGeometry', () => {
  it('uses physical paper sizes and swaps for landscape', () => {
    const portrait = pageGeometry(settings({ paperSize: 'letter' }));
    expect(portrait.widthMm).toBeCloseTo(215.9);
    expect(portrait.width).toBeCloseTo(816, 0);
    const landscape = pageGeometry(settings({ paperSize: 'letter', landscape: true }));
    expect(landscape.width).toBeCloseTo(portrait.height);
  });

  it('keeps at least one text line even with huge margins', () => {
    const g = pageGeometry(settings({ margins: { top: 200, bottom: 200, left: 10, right: 10 } }));
    expect(g.areas[0].lines.length).toBeGreaterThanOrEqual(1);
  });

  it('every template gives a usable page', () => {
    for (const id of ['notebook', 'cornell', 'exam', 'seyes', 'four-line', 'graph', 'index-card', 'register', 'spiral']) {
      const s = applyTemplate(settings(), id);
      const g = pageGeometry(s, 1);
      expect(g.areas.length, id).toBeGreaterThanOrEqual(1);
      for (const a of g.areas) {
        expect(a.lines.length, id).toBeGreaterThan(0);
        expect(a.right - a.left, id).toBeGreaterThan(20);
        expect(a.left, id).toBeGreaterThanOrEqual(0);
        expect(a.right, id).toBeLessThanOrEqual(g.width);
        for (const y of a.lines) expect(y, id).toBeLessThanOrEqual(g.height);
      }
    }
  });

  it('cuts a cue column and a summary box out of the writing area', () => {
    const plain = pageGeometry(settings());
    const cornell = pageGeometry(applyTemplate(settings(), 'cornell'));
    expect(cornell.areas[0].left).toBeGreaterThan(plain.areas[0].left);
    expect(cornell.summaryY).not.toBeNull();
    expect(cornell.areas[0].lines[cornell.areas[0].lines.length - 1]).toBeLessThan(cornell.summaryY!);
  });

  it('draws practice rulings', () => {
    expect(pageGeometry(applyTemplate(settings(), 'four-line')).midRules.length).toBeGreaterThan(5);
    const seyes = pageGeometry(applyTemplate(settings(), 'seyes'));
    expect(seyes.verticalRules.length).toBeGreaterThan(5);
    expect(seyes.midRules.length).toBeGreaterThan(seyes.rules.length);
  });

  it('punches the right number of holes on the binding side', () => {
    const three = pageGeometry(applyTemplate(settings(), 'college'));
    expect(three.holes).toHaveLength(3);
    for (const hole of three.holes) expect(hole.x).toBeLessThan(three.width / 2);
    const spiral = pageGeometry(applyTemplate(settings(), 'spiral'), 1);
    expect(spiral.holes.length).toBeGreaterThan(10);
    for (const hole of spiral.holes) expect(hole.x).toBeGreaterThan(spiral.width / 2);
  });
});

describe('connected fonts', () => {
  it('damp per-letter jitter but keep line drift', () => {
    const s = settings({ text: lorem(40), corrections: 0 });
    const geometryOf = (i: number) => pageGeometry(s, i);
    const loose = layoutDocument(s.text, geometryOf, FONT_PX, s, measure);
    const joined = layoutDocument(s.text, geometryOf, FONT_PX, s, measure, { connected: true });
    const spread = (d: typeof loose) => {
      const g = d.pages[0].glyphs;
      let sum = 0;
      for (let i = 1; i < g.length; i++) sum += Math.abs(g[i].rotation - g[i - 1].rotation);
      return sum / g.length;
    };
    expect(spread(joined)).toBeLessThan(spread(loose) * 0.6);
  });
});
