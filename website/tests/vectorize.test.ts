import { describe, expect, it } from 'vitest';
import { inkThreshold, looksLikeLineArt, luminance, simplify, thin, vectorize } from '../src/import/vectorize';

/** A white canvas to draw test figures on, one byte of grey per pixel. */
function canvas(width: number, height: number) {
  const lum = new Uint8Array(width * height).fill(255);
  const set = (x: number, y: number, v = 0) => {
    if (x >= 0 && y >= 0 && x < width && y < height) lum[Math.round(y) * width + Math.round(x)] = v;
  };
  return {
    lum,
    width,
    height,
    /** A line `w` pixels wide. */
    line(x0: number, y0: number, x1: number, y1: number, w = 2) {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
      for (let i = 0; i <= steps; i++) {
        const x = x0 + ((x1 - x0) * i) / steps;
        const y = y0 + ((y1 - y0) * i) / steps;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < w; dy++) set(x + dx - w / 2, y + dy - w / 2);
      }
    },
    rect(x: number, y: number, w: number, h: number, v = 0) {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, v);
    },
  };
}

const length = (pts: number[]) => {
  let total = 0;
  for (let k = 2; k < pts.length; k += 2) total += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
  return total;
};

describe('vectorize', () => {
  it('traces a straight line as one path from end to end', () => {
    const c = canvas(200, 60);
    c.line(20, 30, 180, 30, 3);
    const v = vectorize(c.lum, c.width, c.height)!;
    expect(v.paths).toHaveLength(1);
    expect(v.fills).toHaveLength(0);
    // Simplified down to its two ends.
    expect(v.paths[0].pts.length).toBe(4);
    expect(length(v.paths[0].pts)).toBeGreaterThan(150);
  });

  it('keeps a box as one closed outline', () => {
    const c = canvas(200, 140);
    c.line(30, 30, 170, 30);
    c.line(170, 30, 170, 110);
    c.line(170, 110, 30, 110);
    c.line(30, 110, 30, 30);
    const v = vectorize(c.lum, c.width, c.height)!;
    expect(v.paths).toHaveLength(1);
    expect(v.paths[0].closed).toBe(true);
    expect(length(v.paths[0].pts)).toBeGreaterThan(400);
  });

  it('carries a line straight on through a crossing', () => {
    const c = canvas(200, 200);
    c.line(20, 100, 180, 100);
    c.line(100, 20, 100, 180);
    const v = vectorize(c.lum, c.width, c.height)!;
    // Two long lines, not four short ones meeting in the middle.
    expect(v.paths).toHaveLength(2);
    for (const p of v.paths) expect(length(p.pts)).toBeGreaterThan(140);
  });

  it('sets solid areas aside to be shaded, keeping their corners', () => {
    const c = canvas(240, 200);
    c.line(20, 180, 220, 180);
    c.rect(60, 60, 50, 120);
    c.rect(140, 100, 50, 80, 120);
    const v = vectorize(c.lum, c.width, c.height)!;
    expect(v.fills).toHaveLength(2);
    // The outline of a bar reaches its top corners rather than rounding them off.
    const bar = v.fills.find((f) => f.pts.some((_, k) => k % 2 === 1 && f.pts[k] < 64))!;
    const top = Math.min(...bar.pts.filter((_, k) => k % 2 === 1));
    const left = Math.min(...bar.pts.filter((_, k) => k % 2 === 0));
    expect(top).toBeLessThan(63);
    expect(left).toBeLessThan(63);
    // A paler fill is marked lighter, and a different colour group.
    const tones = v.fills.map((f) => f.tone).sort((a, b) => a - b);
    expect(tones[1] - tones[0]).toBeGreaterThan(0.3);
    expect(new Set(v.fills.map((f) => f.group)).size).toBe(2);
  });

  it('keeps an arrowhead as a filled shape rather than the end of its shaft', () => {
    const c = canvas(200, 80);
    c.line(20, 40, 160, 40, 2);
    for (let i = 0; i < 16; i++) c.line(160 + i, 40 - (16 - i) * 0.55, 160 + i, 40 + (16 - i) * 0.55, 1);
    const v = vectorize(c.lum, c.width, c.height)!;
    expect(v.fills.length).toBeGreaterThanOrEqual(1);
    const head = v.fills[0];
    expect(Math.max(...head.pts.filter((_, k) => k % 2 === 0))).toBeGreaterThan(170);
  });

  it('leaves out what it is told to ignore', () => {
    const c = canvas(200, 60);
    c.line(20, 30, 180, 30, 3);
    const ignore = new Uint8Array(c.width * c.height).fill(1);
    const v = vectorize(c.lum, c.width, c.height, ignore)!;
    expect(v.paths).toHaveLength(0);
  });

  it('drops dust', () => {
    const c = canvas(100, 100);
    c.rect(50, 50, 1, 1);
    const v = vectorize(c.lum, c.width, c.height)!;
    expect(v.paths).toHaveLength(0);
  });
});

describe('thin', () => {
  it('reduces a thick bar to a line one pixel wide', () => {
    const w = 60;
    const h = 20;
    const m = new Uint8Array(w * h);
    for (let y = 6; y < 13; y++) for (let x = 5; x < 55; x++) m[y * w + x] = 1;
    thin(m, w, h);
    for (let x = 12; x < 48; x++) {
      let column = 0;
      for (let y = 0; y < h; y++) column += m[y * w + x];
      expect(column).toBe(1);
    }
  });
});

describe('telling drawings from photographs', () => {
  it('calls paper with lines on it line art', () => {
    const c = canvas(200, 200);
    c.line(20, 100, 180, 100);
    c.rect(40, 40, 30, 30, 90);
    expect(looksLikeLineArt(c.lum)).toBe(true);
  });

  it('calls a smooth spread of tones a photograph', () => {
    const lum = new Uint8Array(200 * 200);
    for (let i = 0; i < lum.length; i++) lum[i] = (i * 7 + ((i / 200) | 0) * 13) % 256;
    expect(looksLikeLineArt(lum)).toBe(false);
  });

  it('treats a pale-coloured line as ink', () => {
    // Yellow on white has the luminance of a pale grey, but it is a line.
    const data = new Uint8ClampedArray([255, 220, 0, 255, 255, 255, 255, 255]);
    const lum = luminance(data);
    expect(lum[0]).toBeLessThan(150);
    expect(lum[1]).toBe(255);
  });

  it('holds the ink threshold to a sensible band', () => {
    expect(inkThreshold(new Uint8Array(1000).fill(255))).toBeGreaterThanOrEqual(120);
    expect(inkThreshold(new Uint8Array(1000).fill(255))).toBeLessThanOrEqual(205);
  });
});

describe('simplify', () => {
  it('keeps the corners of a polyline and drops the points between', () => {
    const pts: number[] = [];
    for (let x = 0; x <= 10; x++) pts.push(x, 0);
    for (let y = 1; y <= 10; y++) pts.push(10, y);
    expect(simplify(pts, 0.5, false)).toEqual([0, 0, 10, 0, 10, 10]);
  });
});

describe('tracing a letter', () => {
  it('keeps a bold stroke as a line, not a shaded area, when told there are no solids', () => {
    const c = canvas(160, 160);
    c.rect(70, 20, 18, 120);
    const shaded = vectorize(c.lum, c.width, c.height)!;
    expect(shaded.fills.length).toBeGreaterThan(0);
    const traced = vectorize(c.lum, c.width, c.height, null, { solids: false, spurWidths: 0.7, extendEnds: true })!;
    expect(traced.fills).toHaveLength(0);
    expect(traced.paths).toHaveLength(1);
  });

  it('puts back the ends that thinning takes off', () => {
    const c = canvas(200, 60);
    c.line(30, 30, 170, 30, 9);
    const plain = vectorize(c.lum, c.width, c.height, null, { solids: false })!;
    const extended = vectorize(c.lum, c.width, c.height, null, { solids: false, extendEnds: true })!;
    const xs = (v: typeof plain) => v.paths[0].pts.filter((_, k) => k % 2 === 0);
    expect(Math.min(...xs(extended))).toBeLessThan(Math.min(...xs(plain)));
    expect(Math.max(...xs(extended))).toBeGreaterThan(Math.max(...xs(plain)));
    // ...and no further than the ink itself reached.
    expect(Math.min(...xs(extended))).toBeGreaterThan(22);
    expect(Math.max(...xs(extended))).toBeLessThan(178);
  });
});
