/**
 * Handwriting of your own (browser only).
 *
 * Every bundled font is a hand thousands of people have seen: it can be
 * recognised, and every copy of a letter in it starts from the same shape.
 * The only hand nobody can match to a font is one that is not a font: yours.
 *
 * So a hand here is a set of letters written on the screen — with a finger, a
 * stylus or a mouse — each one several times. The strokes are kept as the pen
 * moved, not as outlines, so they are drawn back with whichever pen is chosen,
 * and the copies of each letter are genuinely different, because they were
 * written separately.
 *
 * Hands live in this browser's storage and never leave it, except as a file
 * you save yourself.
 */
import type { StrokeGlyph } from './engine';

/** Characters a hand is asked for, in the order they are offered. */
export const HAND_CHARACTERS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  marks: '.,;:!?\'"-()/&+=%',
};

export const ALL_HAND_CHARACTERS = [...Object.values(HAND_CHARACTERS).join('')];

/** How many times each character is written. */
export const SAMPLES_PER_CHARACTER = 3;

/** One written copy of a character: strokes of x, y, pressure, in em units. */
export interface Sample {
  strokes: number[][];
}

export interface OwnHand {
  version: 1;
  id: string;
  name: string;
  /** Hand used for anything not yet written, so a half-finished hand still works. */
  standIn: string;
  samples: Record<string, Sample[]>;
  updated: number;
}

/** A hand ready to write with: every copy of every letter placed and measured. */
export interface BuiltHand {
  id: string;
  name: string;
  standIn: string;
  xHeight: number;
  capHeight: number;
  /** Pen weight as a fraction of the font size. */
  weight: number;
  glyph(unit: string, variant: number): StrokeGlyph | null;
  has(unit: string): boolean;
  /** Characters written so far. */
  written: number;
}

const STORAGE_KEY = 'handscript.hands.v1';

/**
 * Pad geometry, in em: the baseline at 0, the dashed x-height line at -0.5,
 * the capital line at -0.72, descenders to +0.24. Writing is kept in em as it
 * is captured, so a hand does not depend on the size of the screen it was
 * written on.
 */
export const GUIDE = { xHeight: 0.5, cap: 0.72, descender: 0.24 };

/** Space either side of a letter's ink, in em. */
const BEARING = 0.045;

export function loadHands(): OwnHand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isHand) : [];
  } catch {
    return [];
  }
}

export function saveHands(hands: OwnHand[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hands));
    return true;
  } catch {
    return false;
  }
}

export function newHand(name = 'My handwriting'): OwnHand {
  return {
    version: 1,
    id: Math.random().toString(36).slice(2, 10),
    name,
    standIn: 'Patrick Hand',
    samples: {},
    updated: Date.now(),
  };
}

function isHand(value: unknown): value is OwnHand {
  const h = value as OwnHand;
  return !!h && h.version === 1 && typeof h.id === 'string' && typeof h.name === 'string' && typeof h.samples === 'object' && h.samples !== null;
}

/** Read a hand from a file saved earlier, giving it a fresh id so it never clashes. */
export function parseHandFile(text: string): OwnHand | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isHand(value)) return null;
    return { ...value, id: Math.random().toString(36).slice(2, 10), updated: Date.now() };
  } catch {
    return null;
  }
}

/** Keep coordinates to a thousandth of an em: plenty, and a fraction of the size. */
export function roundSample(sample: Sample): Sample {
  return { strokes: sample.strokes.map((stroke) => stroke.map((v) => Math.round(v * 1000) / 1000)) };
}

function inkRange(sample: Sample): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of sample.strokes) {
    for (let i = 0; i < stroke.length; i += 3) {
      minX = Math.min(minX, stroke[i]);
      maxX = Math.max(maxX, stroke[i]);
      minY = Math.min(minY, stroke[i + 1]);
      maxY = Math.max(maxY, stroke[i + 1]);
    }
  }
  return { minX, maxX, minY, maxY };
}

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const X_LETTERS = 'acemnorsuvwxz';
const CAP_LETTERS = 'EFHIKLMNTXZ';

/**
 * Turn the written samples into glyphs. Every copy of a letter gets the same
 * advance — the layout measures a letter once — with its ink centred in it,
 * so the copies differ in shape and not in spacing.
 */
export function buildHand(hand: OwnHand): BuiltHand {
  const glyphs = new Map<string, StrokeGlyph[]>();
  const heights: number[] = [];
  const caps: number[] = [];
  for (const [ch, samples] of Object.entries(hand.samples)) {
    const usable = samples.filter((s) => s.strokes.some((stroke) => stroke.length >= 3));
    if (usable.length === 0) continue;
    const ranges = usable.map(inkRange);
    const inkWidth = median(
      ranges.map((r) => r.maxX - r.minX),
      0.3,
    );
    // A dot or a comma is narrow; nothing is narrower than a pen's width.
    const advance = Math.max(0.05, inkWidth) + BEARING * 2;
    glyphs.set(
      ch,
      usable.map((sample, k) => {
        const r = ranges[k];
        const shift = (advance - (r.maxX - r.minX)) / 2 - r.minX;
        return {
          advance,
          strokes: sample.strokes.filter((s) => s.length >= 3).map((stroke) => {
            const out = Float32Array.from(stroke);
            for (let i = 0; i < out.length; i += 3) out[i] += shift;
            return out;
          }),
        };
      }),
    );
    if (X_LETTERS.includes(ch)) for (const r of ranges) heights.push(-r.minY);
    if (CAP_LETTERS.includes(ch)) for (const r of ranges) caps.push(-r.minY);
  }
  const xHeight = Math.min(0.9, Math.max(0.2, median(heights, GUIDE.xHeight)));
  const capHeight = Math.min(1.3, Math.max(xHeight * 1.1, median(caps, GUIDE.cap)));
  return {
    id: hand.id,
    name: hand.name,
    standIn: hand.standIn,
    xHeight,
    capHeight,
    // A ballpoint line is about a sixth of the height of a small letter.
    weight: xHeight * 0.17,
    written: glyphs.size,
    has: (unit) => glyphs.has(unit),
    glyph: (unit, variant) => {
      const list = glyphs.get(unit);
      if (!list) return null;
      return list[((variant % list.length) + list.length) % list.length];
    },
  };
}
