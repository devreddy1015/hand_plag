import { describe, expect, it } from 'vitest';
import { otherSide } from '../src/engine/depth';

describe('depth', () => {
  it('pairs each page with the other side of its own sheet', () => {
    expect(otherSide(0)).toBe(1);
    expect(otherSide(1)).toBe(0);
    expect(otherSide(2)).toBe(3);
    expect(otherSide(3)).toBe(2);
    // The back of a sheet never shows the next sheet through it.
    for (let page = 0; page < 40; page++) {
      expect(otherSide(otherSide(page))).toBe(page);
      expect(Math.floor(otherSide(page) / 2)).toBe(Math.floor(page / 2));
    }
  });
});
