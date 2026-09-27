import { describe, expect, it } from 'vitest';
import { findMathBlocks, isMathFont } from '../src/import/math';
import type { Line } from '../src/import/reflow';

const BODY = 11;
const LEADING = 14;
const LEFT = 62;
const RIGHT = 533;

interface Spec {
  text: string;
  y: number;
  x0?: number;
  x1?: number;
  /** Share of the line set in a maths font. */
  math?: number;
  size?: number;
}

function line(spec: Spec): Line {
  return {
    text: spec.text,
    y: spec.y,
    x0: spec.x0 ?? LEFT,
    x1: spec.x1 ?? RIGHT,
    size: spec.size ?? BODY,
    column: 0,
    math: spec.math ?? 0,
  };
}

const prose = (text: string, y: number) => line({ text, y });
const blocks = (lines: Line[]) => findMathBlocks(lines, { bodyLeft: LEFT, bodyRight: RIGHT, leading: LEADING, bodySize: BODY });

describe('isMathFont', () => {
  it('knows TeX’s maths fonts, tag and all', () => {
    expect(isMathFont('LSYTEM+CMMI10')).toBe(true);
    expect(isMathFont('KLGEAZ+CMSY10')).toBe(true);
    expect(isMathFont('TVRVUA+CMEX10')).toBe(true);
    expect(isMathFont('MSBM10')).toBe(true);
    expect(isMathFont('Cambria Math')).toBe(true);
    expect(isMathFont('STIXTwoMath-Regular')).toBe(true);
  });

  it('does not mistake the text fonts for them', () => {
    expect(isMathFont('ZKANVW+CMR10')).toBe(false);
    expect(isMathFont('BVQNXW+CMBX12')).toBe(false);
    expect(isMathFont('Times New Roman')).toBe(false);
    expect(isMathFont(undefined)).toBe(false);
    expect(isMathFont('')).toBe(false);
  });
});

describe('findMathBlocks', () => {
  it('cuts out a displayed equation and leaves the prose alone', () => {
    const before = prose('The proton-motive force is defined as', 100);
    const equation = line({ text: '∆p = ∆ψ − 2.303RT/F ∆pH, (1)', y: 130, x0: 160, x1: 500, math: 0.6 });
    const after = prose('where ∆ψ is the membrane potential and F is the Faraday constant.', 160);
    const { boxes, consumed } = blocks([before, equation, after]);
    expect(boxes).toHaveLength(1);
    expect(consumed.has(equation)).toBe(true);
    expect(consumed.has(before)).toBe(false);
    expect(consumed.has(after)).toBe(false);
  });

  it('takes the whole of a stacked fraction, not the middle line only', () => {
    const numerator = line({ text: '2.303RT', y: 124, x0: 250, x1: 300, math: 0.5 });
    const middle = line({ text: '∆p = ∆ψ −  ∆pH,  (1)', y: 134, x0: 160, x1: 500, math: 0.6 });
    const denominator = line({ text: 'F', y: 145, x0: 262, x1: 272, math: 1 });
    const { boxes, consumed } = blocks([prose('Above.', 100), numerator, middle, denominator, prose('Below.', 180)]);
    expect(boxes).toHaveLength(1);
    expect(consumed.size).toBe(3);
    // The box reaches from above the numerator to below the denominator.
    expect(boxes[0].y).toBeLessThan(124 - BODY);
    expect(boxes[0].y + boxes[0].height).toBeGreaterThan(145);
  });

  it('leaves inline maths inside a paragraph where it is', () => {
    const paragraph = line({ text: 'The gradient ∆p has a chemical term and an electrical term.', y: 100, math: 0.2 });
    const { boxes, consumed } = blocks([paragraph]);
    expect(boxes).toHaveLength(0);
    expect(consumed.size).toBe(0);
  });

  it('does not mistake a centred heading for an equation', () => {
    const heading = line({ text: 'Oxidative Phosphorylation', y: 100, x0: 180, x1: 400, math: 0 });
    expect(blocks([heading]).boxes).toHaveLength(0);
  });

  it('keeps two equations apart when prose runs between them', () => {
    const first = line({ text: 'a = b + c (1)', y: 100, x0: 200, x1: 480, math: 0.7 });
    const between = prose('and therefore, by the same argument as before,', 140);
    const second = line({ text: 'd = e − f (2)', y: 180, x0: 200, x1: 480, math: 0.7 });
    const { boxes, consumed } = blocks([first, between, second]);
    expect(boxes).toHaveLength(2);
    expect(consumed.has(between)).toBe(false);
  });

  it('gathers the lines of an aligned pair into one block', () => {
    const one = line({ text: 'n = Σ n_i ,', y: 100, x0: 200, x1: 480, math: 0.8 });
    const two = line({ text: '∆G = −nF∆p + RT ln K .', y: 118, x0: 200, x1: 480, math: 0.8 });
    const { boxes } = blocks([prose('Summing over the three complexes gives', 70), one, two, prose('The stoichiometry is not an integer.', 150)]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].height).toBeGreaterThan(18);
  });
});
