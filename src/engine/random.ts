/**
 * Deterministic randomness. Every random choice in the engine goes through
 * these helpers, so the same seed and settings always give the same page, and
 * the preview matches the export pixel for pixel.
 */

export type Rng = () => number;

/** 32-bit FNV-1a hash of a string, mixed with a seed. */
export function hashString(str: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix(h);
}

/** Hash a list of integers into one well-mixed 32-bit value. */
export function hashInts(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b);
    h = (h << 13) | (h >>> 19);
    h = Math.imul(h, 0xc2b2ae35);
  }
  return fmix(h);
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Small, fast PRNG with a 32-bit state. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller), clamped to ±3 so outliers stay tame. */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-3, Math.min(3, n));
}

/**
 * Smooth 1D value noise in [-1, 1] with two octaves. Used for slow drifts
 * such as baseline wander, slant drift and ink flow along a line.
 */
export function createNoise1D(seed: number): (x: number) => number {
  const lattice = (i: number) => (hashInts(seed, i) / 4294967295) * 2 - 1;
  const octave = (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const t = f * f * f * (f * (f * 6 - 15) + 10); // smootherstep
    const a = lattice(i);
    const b = lattice(i + 1);
    return a + (b - a) * t;
  };
  return (x: number) => octave(x) * 0.7 + octave(x * 2.3 + 17.1) * 0.3;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
