import { describe, expect, it } from 'vitest';
import { penDynamics, smoothSamples, type Sample } from '../src/engine/pen';
import { mulberry32 } from '../src/engine/random';

const SIZE = 20;

/** A straight stroke from one point to another, sampled finely. */
const line = (x0: number, y0: number, x1: number, y1: number): Sample[] => smoothSamples([x0, y0, x1, y1], 2, 0.5);

const mean = (values: ArrayLike<number>, from = 0, to = values.length) => {
  let total = 0;
  for (let i = from; i < to; i++) total += values[i];
  return total / (to - from);
};

describe('penDynamics', () => {
  it('presses harder on a down-stroke than on an up-stroke', () => {
    const down = line(0, 0, 0, 40);
    const up = line(0, 40, 0, 0);
    penDynamics(down, mulberry32(1), SIZE, 0.12);
    penDynamics(up, mulberry32(1), SIZE, 0.12);
    expect(mean(down.map((s) => s.p))).toBeGreaterThan(mean(up.map((s) => s.p)) * 1.15);
  });

  it('starts and ends slower than it runs in the middle', () => {
    const samples = line(0, 0, 60, 0);
    const speed = penDynamics(samples, mulberry32(2), SIZE, 0.12);
    const n = speed.length;
    expect(speed[0]).toBeLessThan(speed[Math.floor(n / 2)] * 0.5);
    expect(speed[n - 1]).toBeLessThan(speed[Math.floor(n / 2)] * 0.5);
  });

  it('all but stops at a cusp before turning back', () => {
    // Down and straight back up, as in the point of a "v".
    const samples = smoothSamples([0, 0, 10, 30, 20, 0], 2, 0.4);
    const speed = penDynamics(samples, mulberry32(3), SIZE, 0.12);
    let tip = 0;
    for (let i = 1; i < samples.length; i++) if (samples[i].y > samples[tip].y) tip = i;
    const quarter = Math.floor(tip / 2);
    expect(speed[tip]).toBeLessThan(speed[quarter]);
  });

  it('lets a slow pen leave a wider line', () => {
    const tight = smoothSamples([0, 0, 4, 0, 4, 4, 0, 4, 0, 1], 2, 0.3);
    const straight = line(0, 0, 0, 40);
    const fast = penDynamics(straight, mulberry32(4), SIZE, 0.3);
    const slow = penDynamics(tight, mulberry32(4), SIZE, 0.3);
    expect(mean(slow)).toBeLessThan(mean(fast));
  });

  it('is the same for the same seed', () => {
    const a = line(0, 0, 30, 30);
    const b = line(0, 0, 30, 30);
    expect(Array.from(penDynamics(a, mulberry32(5), SIZE, 0.2))).toEqual(Array.from(penDynamics(b, mulberry32(5), SIZE, 0.2)));
    expect(a).toEqual(b);
  });
});
