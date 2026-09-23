/**
 * Handwriting font catalog (browser only). Every bundled font is SIL OFL 1.1
 * or Apache 2.0, both of which allow commercial use and server-side
 * rendering. Fonts are self-hosted from npm (@fontsource), split by
 * unicode-range, so only the subsets a document uses are downloaded.
 */
import '@fontsource/caveat/400.css';
import '@fontsource/kalam/400.css';
import '@fontsource/indie-flower/400.css';
import '@fontsource/shadows-into-light/400.css';
import '@fontsource/patrick-hand/400.css';
import '@fontsource/gochi-hand/400.css';
import '@fontsource/reenie-beanie/400.css';
import '@fontsource/homemade-apple/400.css';
import '@fontsource/cedarville-cursive/400.css';
import '@fontsource/neucha/400.css';
import '@fontsource/nanum-pen-script/400.css';
import '@fontsource/yomogi/400.css';
import '@fontsource/ma-shan-zheng/400.css';
import '@fontsource/aref-ruqaa/400.css';

import { detectScripts, scriptOf, type Measurer, type ScriptTag } from './engine';

export interface FontEntry {
  id: string;
  family: string;
  label: string;
  /** Scripts the font covers well. */
  scripts: ScriptTag[];
  license: string;
  /** Letters join up (cursive), so per-letter jitter is damped. */
  connected?: boolean;
  custom?: boolean;
}

export const FONTS: FontEntry[] = [
  { id: 'caveat', family: 'Caveat', label: 'Caveat: casual', scripts: ['latin', 'cyrillic'], license: 'OFL-1.1' },
  { id: 'kalam', family: 'Kalam', label: 'Kalam: neat print', scripts: ['latin', 'devanagari'], license: 'OFL-1.1' },
  { id: 'patrick-hand', family: 'Patrick Hand', label: 'Patrick Hand: tidy print', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'indie-flower', family: 'Indie Flower', label: 'Indie Flower: rounded', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'shadows-into-light', family: 'Shadows Into Light', label: 'Shadows Into Light: narrow', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'gochi-hand', family: 'Gochi Hand', label: 'Gochi Hand: marker', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'reenie-beanie', family: 'Reenie Beanie', label: 'Reenie Beanie: quick scrawl', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'homemade-apple', family: 'Homemade Apple', label: 'Homemade Apple: loopy cursive', scripts: ['latin'], license: 'Apache-2.0', connected: true },
  { id: 'cedarville-cursive', family: 'Cedarville Cursive', label: 'Cedarville: school cursive', scripts: ['latin'], license: 'OFL-1.1', connected: true },
  { id: 'neucha', family: 'Neucha', label: 'Neucha: Cyrillic print', scripts: ['latin', 'cyrillic'], license: 'OFL-1.1' },
  { id: 'nanum-pen-script', family: 'Nanum Pen Script', label: 'Nanum Pen Script: Korean', scripts: ['latin', 'hangul'], license: 'OFL-1.1' },
  { id: 'yomogi', family: 'Yomogi', label: 'Yomogi: Japanese', scripts: ['latin', 'cyrillic', 'kana', 'han'], license: 'OFL-1.1' },
  { id: 'ma-shan-zheng', family: 'Ma Shan Zheng', label: 'Ma Shan Zheng: Chinese brush', scripts: ['latin', 'han'], license: 'OFL-1.1' },
];

/** Handwriting fonts used for characters the chosen font lacks. */
const FALLBACKS: Partial<Record<ScriptTag, string>> = {
  cyrillic: 'Caveat',
  devanagari: 'Kalam',
  hangul: 'Nanum Pen Script',
  kana: 'Yomogi',
  han: 'Ma Shan Zheng',
  arabic: 'Aref Ruqaa',
};

const customFonts: FontEntry[] = [];

export function allFonts(): FontEntry[] {
  return [...customFonts, ...FONTS];
}

export function findFont(id: string): FontEntry {
  return allFonts().find((f) => f.id === id) ?? FONTS[0];
}

/** The chosen font followed by handwriting fallbacks for any other scripts in the text. */
export function fontFamiliesFor(font: FontEntry, text: string): string[] {
  const scripts = detectScripts(text);
  const families = [font.family];
  for (const script of scripts) {
    if (font.scripts.includes(script)) continue;
    // Japanese text uses kanji too; keep it in one Japanese font.
    const fallback = script === 'han' && scripts.has('kana') ? 'Yomogi' : FALLBACKS[script];
    if (fallback && !families.includes(fallback)) families.push(fallback);
  }
  return families;
}

export function cssFontStack(families: string[]): string {
  return [...families.map((f) => `"${f.replace(/["\\]/g, '')}"`), 'cursive'].join(', ');
}

/** Make sure every font subset the text needs is downloaded before drawing. */
export async function loadFonts(families: string[], text: string): Promise<void> {
  // x and H are always needed: they are measured to size each font.
  const chars = new Set<string>(['x', 'H']);
  for (const ch of text) {
    chars.add(ch);
    if (chars.size > 6000) break;
  }
  const sample = [...chars].join('') || 'abc';
  await Promise.all(
    families.map((family) => document.fonts.load(`32px "${family}"`, sample).catch(() => [])),
  );
}

let measureCanvas: HTMLCanvasElement | null = null;
function measureContext(): CanvasRenderingContext2D {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

const metricCache = new Map<string, { xHeight: number; capHeight: number }>();

/** x-height and cap height as fractions of the font size. */
export function fontMetrics(family: string): { xHeight: number; capHeight: number } {
  const cached = metricCache.get(family);
  if (cached) return cached;
  const ctx = measureContext();
  ctx.font = `100px "${family}"`;
  // Ink height (ascent + descent): some fonts draw Latin letters floating
  // above the baseline, which would inflate an ascent-only measurement.
  const inkHeight = (ch: string) => {
    const m = ctx.measureText(ch);
    return (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 100;
  };
  const x = inkHeight('x');
  const cap = inkHeight('H');
  const metrics = {
    xHeight: x > 0.1 && x < 1.2 ? x : 0.45,
    capHeight: cap > 0.2 && cap < 1.6 ? cap : 0.7,
  };
  metricCache.set(family, metrics);
  return metrics;
}

/**
 * Size factor per unit so characters drawn by a fallback font match the main
 * font's x-height instead of coming out much larger or smaller.
 */
export function fallbackScaler(font: FontEntry, families: string[]): (unit: string) => number {
  const scales = new Map<ScriptTag, number>();
  const main = fontMetrics(font.family).xHeight;
  for (const [script, family] of Object.entries(FALLBACKS) as [ScriptTag, string][]) {
    if (font.scripts.includes(script) || !families.includes(family)) continue;
    scales.set(script, Math.min(1.6, Math.max(0.5, main / fontMetrics(family).xHeight)));
  }
  // Kanji in Japanese text are drawn by Yomogi, not the Chinese fallback.
  if (!font.scripts.includes('han') && families.includes('Yomogi') && scales.has('kana')) {
    scales.set('han', scales.get('kana')!);
  }
  if (scales.size === 0) return () => 1;
  const cache = new Map<string, number>();
  return (unit) => {
    let v = cache.get(unit);
    if (v === undefined) {
      const script = scriptOf(unit);
      v = (script && scales.get(script)) || 1;
      cache.set(unit, v);
    }
    return v;
  };
}

/** Text measurer at a given layout font size. Measures at 100px for precision. */
export function createMeasurer(stack: string, fontPx: number): Measurer {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.font = `100px ${stack}`;
  const k = fontPx / 100;
  return (text: string) => ctx.measureText(text).width * k;
}

/** Register a user's own handwriting font file (TTF, OTF, WOFF, WOFF2). */
export async function addCustomFont(file: File): Promise<FontEntry> {
  const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').slice(0, 40) || 'My font';
  const family = `User Font ${customFonts.length + 1} ${name}`.replace(/["\\]/g, '');
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  metricCache.delete(family);
  const entry: FontEntry = {
    id: `custom:${family}`,
    family,
    label: `${name} (your font)`,
    scripts: ['latin'],
    license: 'Supplied by you',
    custom: true,
  };
  customFonts.unshift(entry);
  return entry;
}
