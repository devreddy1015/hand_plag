import { describe, expect, it } from 'vitest';
import { naturalWay } from '../src/strokefont';

/** The points of a traced stroke, without the pressure that comes with each. */
const points = (stroke: Float32Array) => Array.from(stroke).filter((_, i) => i % 3 !== 2);

describe('naturalWay', () => {
  it('writes an upright stroke downwards', () => {
    expect(points(naturalWay([0, 0.25, 0, -0.5], false))).toEqual([0, -0.5, 0, 0.25]);
    expect(points(naturalWay([0, -0.5, 0, 0.25], false))).toEqual([0, -0.5, 0, 0.25]);
  });

  it('writes a level stroke from left to right', () => {
    expect(points(naturalWay([0.5, -0.375, 0, -0.375], false))).toEqual([0, -0.375, 0.5, -0.375]);
  });

  it('goes round a loop anticlockwise from its top', () => {
    // A square loop given clockwise from its left: top, right, bottom, left on the page (y down).
    const loop = naturalWay([0, -0.25, 0.25, -0.5, 0.5, -0.25, 0.25, 0], true);
    const pts = points(loop);
    expect(pts.slice(0, 2)).toEqual([0.25, -0.5]);
    // Next it heads left, and it closes where it began.
    expect(pts[2]).toBeLessThan(0.25);
    expect(pts.slice(-2)).toEqual([0.25, -0.5]);
  });
});
