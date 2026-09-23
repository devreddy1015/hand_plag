import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, layoutDocument, pageGeometry, type Settings } from '../src/engine';

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

function layout(text: string, overrides: Partial<Settings> = {}) {
  const s = settings({ text, ...overrides });
  return layoutDocument(text, pageGeometry(s), FONT_PX, s, measure);
}

const lorem = (words: number) =>
  Array.from({ length: words }, (_, i) => ['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]).join(' ');

describe('layoutDocument', () => {
  it('is deterministic for the same seed', () => {
    expect(layout(lorem(200))).toEqual(layout(lorem(200)));
  });

  it('changes with the seed', () => {
    const a = layout(lorem(50), { seed: 1 });
    const b = layout(lorem(50), { seed: 2 });
    expect(a.pages[0].glyphs[5]).not.toEqual(b.pages[0].glyphs[5]);
  });

  it('keeps every letter, in order', () => {
    const text = 'The quick brown fox\njumps over\n\nthe lazy dog.';
    const doc = layout(text);
    const drawn = doc.pages.flatMap((p) => p.glyphs.map((g) => g.text)).join('');
    expect(drawn).toBe(text.replace(/\s/g, ''));
  });

  it('wraps inside the text area', () => {
    const doc = layout(lorem(600));
    const { textLeft, textRight } = doc.geometry;
    for (const page of doc.pages) {
      for (const g of page.glyphs) {
        expect(g.x).toBeGreaterThanOrEqual(textLeft - 0.001);
        expect(g.x + 10 * g.scaleX).toBeLessThanOrEqual(textRight + 0.001);
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

  it('puts text on the ruled lines when messiness is zero', () => {
    const doc = layout('hello world\nsecond line', { messiness: 0, slant: 0 });
    const lines = doc.geometry.textLines;
    const ys = [...new Set(doc.pages[0].glyphs.map((g) => g.y.toFixed(3)))].map(Number);
    expect(ys).toHaveLength(2);
    expect(ys[0]).toBeLessThan(lines[0]);
    expect(lines[0] - ys[0]).toBeLessThan(doc.geometry.spacing * 0.2);
    for (const g of doc.pages[0].glyphs) {
      expect(g.rotation).toBeCloseTo(0, 12);
      expect(g.skew).toBeCloseTo(0, 12);
      expect(g.scaleX).toBe(1);
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
    expect(b.y - a.y).toBeCloseTo(doc.geometry.spacing * 3, 5);
  });

  it('splits a word longer than a line', () => {
    const doc = layout('x'.repeat(400));
    const ys = new Set(doc.pages[0].glyphs.map((g) => Math.round(g.y / doc.geometry.spacing)));
    expect(ys.size).toBeGreaterThan(1);
    for (const g of doc.pages[0].glyphs) expect(g.x).toBeLessThanOrEqual(doc.geometry.textRight);
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
    expect(first.x + 40).toBeCloseTo(doc.geometry.textRight, 5);
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
    expect(g.textLines.length).toBeGreaterThanOrEqual(1);
  });
});

describe('connected fonts', () => {
  it('damp per-letter jitter but keep line drift', () => {
    const s = settings({ text: lorem(40) });
    const geom = pageGeometry(s);
    const loose = layoutDocument(s.text, geom, FONT_PX, s, measure);
    const joined = layoutDocument(s.text, geom, FONT_PX, s, measure, { connected: true });
    const spread = (d: typeof loose) => {
      const g = d.pages[0].glyphs;
      let sum = 0;
      for (let i = 1; i < g.length; i++) sum += Math.abs(g[i].rotation - g[i - 1].rotation);
      return sum / g.length;
    };
    expect(spread(joined)).toBeLessThan(spread(loose) * 0.6);
  });
});
