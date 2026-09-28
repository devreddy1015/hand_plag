import { describe, expect, it } from 'vitest';
import { buildHand, newHand, parseHandFile, roundSample, type OwnHand } from '../src/hands';

/** A letter written as one stroke through these points, at full pressure. */
const stroke = (...pts: [number, number][]) => pts.flatMap(([x, y]) => [x, y, 1]);

function hand(): OwnHand {
  const h = newHand('Test hand');
  h.samples = {
    // Three copies of an "o", at different places and widths on the pad.
    o: [
      { strokes: [stroke([0.3, -0.5], [0.5, -0.25], [0.3, 0], [0.1, -0.25], [0.3, -0.5])] },
      { strokes: [stroke([1.3, -0.48], [1.52, -0.24], [1.3, 0], [1.08, -0.24], [1.3, -0.48])] },
      { strokes: [stroke([0.6, -0.52], [0.78, -0.26], [0.6, 0.01], [0.42, -0.26], [0.6, -0.52])] },
    ],
    H: [{ strokes: [stroke([0.1, -0.74], [0.1, 0]), stroke([0.5, -0.74], [0.5, 0]), stroke([0.1, -0.37], [0.5, -0.37])] }],
    x: [{ strokes: [stroke([0, -0.44], [0.4, 0]), stroke([0.4, -0.44], [0, 0])] }],
  };
  return h;
}

describe('your own hand', () => {
  it('gives every copy of a letter the same advance, with its ink centred in it', () => {
    const built = buildHand(hand());
    const copies = [0, 1, 2].map((v) => built.glyph('o', v)!);
    expect(new Set(copies.map((g) => g.advance)).size).toBe(1);
    for (const g of copies) {
      const xs = g.strokes.flatMap((s) => [...s].filter((_, i) => i % 3 === 0));
      const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
      expect(middle).toBeCloseTo(g.advance / 2, 5);
    }
  });

  it('keeps the copies different: they were written separately', () => {
    const built = buildHand(hand());
    expect(built.glyph('o', 0)!.strokes[0]).not.toEqual(built.glyph('o', 1)!.strokes[0]);
    // Variants beyond the number written come round again.
    expect(built.glyph('o', 3)).toBe(built.glyph('o', 0));
  });

  it('measures its own proportions', () => {
    const built = buildHand(hand());
    expect(built.xHeight).toBeGreaterThan(0.4);
    expect(built.xHeight).toBeLessThan(0.6);
    expect(built.capHeight).toBeGreaterThan(0.7);
    expect(built.written).toBe(3);
    expect(built.has('o')).toBe(true);
    expect(built.has('q')).toBe(false);
  });

  it('rounds what it stores', () => {
    expect(roundSample({ strokes: [[0.123456, -0.98765, 1]] }).strokes[0]).toEqual([0.123, -0.988, 1]);
  });

  it('reads back a hand saved to a file, under a new id', () => {
    const original = hand();
    const read = parseHandFile(JSON.stringify(original))!;
    expect(read.name).toBe('Test hand');
    expect(read.id).not.toBe(original.id);
    expect(parseHandFile('{"not":"a hand"}')).toBeNull();
    expect(parseHandFile('nonsense')).toBeNull();
  });
});
