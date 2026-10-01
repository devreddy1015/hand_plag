import { describe, expect, it } from 'vitest';
import {
  OutlineBuilder,
  createWarp,
  hasSymbol,
  outlineInk,
  parseStrokes,
  penWeightOf,
  symbolCharacters,
  symbolGlyph,
  traceOutline,
  type PathSink,
} from '../src/engine';

const WARP = { amount: 1, handSeed: 7, unit: 'e', variant: 0, instanceSeed: 1, advance: 0.5, xHeight: 0.45, pinEnds: false };

/** Where a warp sends a few points across a letter. */
function probe(warp: ReturnType<typeof createWarp>) {
  const out: number[] = [];
  const p = [0, 0];
  for (const [x, y] of [
    [0.1, -0.2],
    [0.25, -0.4],
    [0.4, -0.1],
    [0.25, -0.7],
    [0.2, 0.15],
  ]) {
    warp!(x, y, p);
    out.push(p[0], p[1]);
  }
  return out;
}

describe('bending letters', () => {
  it('leaves a letter alone at amount zero', () => {
    expect(createWarp({ ...WARP, amount: 0 })).toBeNull();
  });

  it('is the same for the same seeds', () => {
    expect(probe(createWarp(WARP))).toEqual(probe(createWarp(WARP)));
  });

  it('bends every copy of a letter differently', () => {
    const a = probe(createWarp(WARP));
    const b = probe(createWarp({ ...WARP, instanceSeed: 2 }));
    expect(a).not.toEqual(b);
  });

  it('keeps a habit: copies of one form differ less than two forms do', () => {
    const spread = (x: number[], y: number[]) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0);
    let sameForm = 0;
    let otherForm = 0;
    for (let i = 0; i < 40; i++) {
      sameForm += spread(probe(createWarp({ ...WARP, instanceSeed: i })), probe(createWarp({ ...WARP, instanceSeed: i + 100 })));
      otherForm += spread(
        probe(createWarp({ ...WARP, variant: 0, instanceSeed: i })),
        probe(createWarp({ ...WARP, variant: 1, instanceSeed: i + 100 })),
      );
    }
    expect(otherForm).toBeGreaterThan(sameForm);
  });

  it('bends gently: nothing moves more than a small part of the letter', () => {
    for (let i = 0; i < 50; i++) {
      const moved = probe(createWarp({ ...WARP, instanceSeed: i, variant: i % 5 }));
      const original = [0.1, -0.2, 0.25, -0.4, 0.4, -0.1, 0.25, -0.7, 0.2, 0.15];
      for (let k = 0; k < moved.length; k++) expect(Math.abs(moved[k] - original[k])).toBeLessThan(0.12);
    }
  });

  it('keeps the ends of a cursive letter where they join', () => {
    const warp = createWarp({ ...WARP, pinEnds: true })!;
    const p = [0, 0];
    warp(0, -0.1, p);
    expect(p[0]).toBeCloseTo(0, 6);
    expect(p[1]).toBeCloseTo(-0.1, 6);
    warp(0.5, -0.3, p);
    expect(p[0]).toBeCloseTo(0.5, 6);
  });
});

describe('outlines', () => {
  const square = () => {
    const b = new OutlineBuilder();
    b.moveTo(0, 0);
    b.lineTo(0.5, 0);
    b.lineTo(0.5, -0.1);
    b.lineTo(0, -0.1);
    b.close();
    return b.done();
  };

  it('measures the ink of an outline', () => {
    const ink = outlineInk(square());
    expect(ink.area).toBeCloseTo(0.05, 6);
    expect(ink.maxX - ink.minX).toBeCloseTo(0.5, 6);
  });

  it('reads the pen weight off a hyphen', () => {
    // A hyphen 0.1 em thick means a pen about that wide.
    expect(penWeightOf(square())).toBeGreaterThan(0.1);
    expect(penWeightOf(square())).toBeLessThan(0.13);
    expect(penWeightOf(null)).toBeGreaterThan(0);
  });

  it('traces onto a path, scaled to the font size', () => {
    const calls: string[] = [];
    const sink: PathSink = {
      moveTo: (x, y) => calls.push(`M${x},${y}`),
      lineTo: (x, y) => calls.push(`L${x},${y}`),
      quadraticCurveTo: () => calls.push('Q'),
      bezierCurveTo: () => calls.push('C'),
      closePath: () => calls.push('Z'),
    };
    traceOutline(sink, square(), 10, null);
    expect(calls[0]).toBe('M0,0');
    expect(calls[1]).toBe('L5,0');
    expect(calls.at(-1)).toBe('Z');
  });
});

describe('Greek and mathematics drawn with the pen', () => {
  it('covers the letters and signs notes are full of', () => {
    for (const ch of 'αβγδεθλμπσφωΔΣΩ∫√∞≤≥≠≈→∂∇±×') expect(hasSymbol(ch)).toBe(true);
    // The increment sign and the micro sign are the same letters as Δ and μ.
    expect(hasSymbol('∆')).toBe(true);
    expect(hasSymbol('µ')).toBe(true);
    expect(hasSymbol('a')).toBe(false);
  });

  it('parses every glyph into strokes that stay near its box', () => {
    for (const ch of symbolCharacters()) {
      const glyph = symbolGlyph(ch, 0.5)!;
      expect(glyph.strokes.length).toBeGreaterThan(0);
      for (const stroke of glyph.strokes) {
        for (let i = 0; i < stroke.length; i += 3) {
          expect(stroke[i]).toBeGreaterThan(-0.2);
          expect(stroke[i]).toBeLessThan(glyph.advance + 0.2);
          expect(stroke[i + 1]).toBeGreaterThan(-1);
          expect(stroke[i + 1]).toBeLessThan(0.4);
        }
      }
    }
  });

  it('fits capitals to the hand’s capital height and small letters to its x-height', () => {
    const lowX = (ch: string, xh: number, cap: number) => {
      const g = symbolGlyph(ch, xh, cap)!;
      return Math.min(...g.strokes.flatMap((s) => [...s].filter((_, i) => i % 3 === 1)));
    };
    expect(lowX('Δ', 0.35, 0.7)).toBeCloseTo(-0.7, 1);
    expect(lowX('α', 0.35, 0.7)).toBeGreaterThan(-0.4);
  });

  it('lifts the pen at every M', () => {
    expect(parseStrokes('M0 0 L1 0 M0 1 L1 1')).toHaveLength(2);
  });
});
