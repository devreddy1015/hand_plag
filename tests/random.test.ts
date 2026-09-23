import { describe, expect, it } from 'vitest';
import { createNoise1D, gaussian, hashInts, hashString, mulberry32 } from '../src/engine/random';

describe('random', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds give different streams', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it('hashes are stable and spread out', () => {
    expect(hashString('hello', 1)).toBe(hashString('hello', 1));
    expect(hashString('hello', 1)).not.toBe(hashString('hello', 2));
    expect(hashInts(1, 2, 3)).not.toBe(hashInts(3, 2, 1));
  });

  it('gaussian is clamped to ±3 with mean near 0', () => {
    const rng = mulberry32(7);
    let sum = 0;
    for (let i = 0; i < 5000; i++) {
      const g = gaussian(rng);
      expect(Math.abs(g)).toBeLessThanOrEqual(3);
      sum += g;
    }
    expect(Math.abs(sum / 5000)).toBeLessThan(0.08);
  });

  it('noise is continuous and bounded', () => {
    const noise = createNoise1D(99);
    let prev = noise(0);
    for (let x = 0.01; x < 20; x += 0.01) {
      const v = noise(x);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.1);
      prev = v;
    }
  });
});
