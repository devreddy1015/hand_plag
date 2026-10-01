/**
 * Handwriting font catalog (browser only). Every bundled font is SIL OFL 1.1
 * or Apache 2.0, both of which allow commercial use and server-side
 * rendering. Fonts are self-hosted from npm (@fontsource), split by
 * unicode-range, so only the subsets a document uses are downloaded.
 *
 * The @font-face rules are imported per font, on demand: twenty hands with
 * full CJK coverage come to a third of a megabyte of CSS, which nobody should
 * download to write one page of English.
 */
import { detectScripts, scriptOf, type Measurer, type ScriptTag } from './engine';
import type { BuiltHand } from './hands';
import { registerOutlines } from './outlines';


/** The @font-face rules for each family, fetched the first time it is used. */
const FONT_CSS: Record<string, () => Promise<unknown>> = {
  'Caveat': () => import('@fontsource/caveat/400.css'),
  'Kalam': () => import('@fontsource/kalam/400.css'),
  'Architects Daughter': () => import('@fontsource/architects-daughter/400.css'),
  'Covered By Your Grace': () => import('@fontsource/covered-by-your-grace/400.css'),
  'Indie Flower': () => import('@fontsource/indie-flower/400.css'),
  'Shadows Into Light': () => import('@fontsource/shadows-into-light/400.css'),
  'Patrick Hand': () => import('@fontsource/patrick-hand/400.css'),
  'Just Another Hand': () => import('@fontsource/just-another-hand/400.css'),
  'Gochi Hand': () => import('@fontsource/gochi-hand/400.css'),
  'Rock Salt': () => import('@fontsource/rock-salt/400.css'),
  'Reenie Beanie': () => import('@fontsource/reenie-beanie/400.css'),
  'Homemade Apple': () => import('@fontsource/homemade-apple/400.css'),
  'Cedarville Cursive': () => import('@fontsource/cedarville-cursive/400.css'),
  'Zeyada': () => import('@fontsource/zeyada/400.css'),
  'Dawning of a New Day': () => import('@fontsource/dawning-of-a-new-day/400.css'),
  'Neucha': () => import('@fontsource/neucha/400.css'),
  'Nanum Pen Script': () => import('@fontsource/nanum-pen-script/400.css'),
  'Yomogi': () => import('@fontsource/yomogi/400.css'),
  'Ma Shan Zheng': () => import('@fontsource/ma-shan-zheng/400.css'),
  'Aref Ruqaa': () => import('@fontsource/aref-ruqaa/400.css'),
};

const cssLoaded = new Map<string, Promise<unknown>>();

/** Fetch the @font-face rules for these families, once each. */
export function loadFontCss(families: string[]): Promise<unknown> {
  return Promise.all(
    families.map((family) => {
      const loader = FONT_CSS[family];
      if (!loader) return Promise.resolve();
      let pending = cssLoaded.get(family);
      if (!pending) {
        pending = loader().catch(() => undefined);
        cssLoaded.set(family, pending);
      }
      return pending;
    }),
  );
}

export type FontGroup = 'Your hands' | 'Print' | 'Cursive' | 'Bold hand' | 'World scripts' | 'Your fonts';

export interface FontEntry {
  id: string;
  family: string;
  /** Short name, as the writer would recognise it. */
  label: string;
  /** What the hand looks like. */
  note: string;
  group: FontGroup;
  /** Scripts the font covers well. */
  scripts: ScriptTag[];
  license: string;
  /** Letters join up (cursive), so per-letter jitter is damped. */
  connected?: boolean;
  custom?: boolean;
  /** Your own handwriting, written on the pad. `family` is then the hand that stands in for letters not yet written. */
  hand?: BuiltHand;
}

export const FONTS: FontEntry[] = [
  { id: 'caveat', family: 'Caveat', label: 'Caveat', note: 'Quick casual notes', group: 'Print', scripts: ['latin', 'cyrillic'], license: 'OFL-1.1' },
  { id: 'kalam', family: 'Kalam', label: 'Kalam', note: 'Neat, even print', group: 'Print', scripts: ['latin', 'devanagari'], license: 'OFL-1.1' },
  {
    id: 'architects-daughter',
    family: 'Architects Daughter',
    label: 'Architect',
    note: 'Upright drafting hand',
    group: 'Print',
    scripts: ['latin'],
    license: 'OFL-1.1',
  },
  {
    id: 'covered-by-your-grace',
    family: 'Covered By Your Grace',
    label: 'Covered',
    note: 'Fast school print',
    group: 'Print',
    scripts: ['latin'],
    license: 'OFL-1.1',
  },
  { id: 'patrick-hand', family: 'Patrick Hand', label: 'Patrick', note: 'Tidy, rounded print', group: 'Print', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'indie-flower', family: 'Indie Flower', label: 'Indie', note: 'Bubbly and round', group: 'Print', scripts: ['latin'], license: 'OFL-1.1' },
  {
    id: 'shadows-into-light',
    family: 'Shadows Into Light',
    label: 'Shadows',
    note: 'Narrow, light touch',
    group: 'Print',
    scripts: ['latin'],
    license: 'OFL-1.1',
  },
  {
    id: 'just-another-hand',
    family: 'Just Another Hand',
    label: 'Tall hand',
    note: 'Tall, narrow, hurried',
    group: 'Print',
    scripts: ['latin'],
    license: 'Apache-2.0',
  },
  { id: 'reenie-beanie', family: 'Reenie Beanie', label: 'Reenie', note: 'Loose ballpoint scrawl', group: 'Print', scripts: ['latin'], license: 'OFL-1.1' },
  {
    id: 'homemade-apple',
    family: 'Homemade Apple',
    label: 'Homemade',
    note: 'Looping ink cursive',
    group: 'Cursive',
    scripts: ['latin'],
    license: 'Apache-2.0',
    connected: true,
  },
  {
    id: 'cedarville-cursive',
    family: 'Cedarville Cursive',
    label: 'Cedarville',
    note: 'School cursive',
    group: 'Cursive',
    scripts: ['latin'],
    license: 'OFL-1.1',
    connected: true,
  },
  { id: 'zeyada', family: 'Zeyada', label: 'Zeyada', note: 'Flowing, inky cursive', group: 'Cursive', scripts: ['latin'], license: 'OFL-1.1', connected: true },
  {
    id: 'dawning-of-a-new-day',
    family: 'Dawning of a New Day',
    label: 'Dawning',
    note: 'Fine fountain-pen cursive',
    group: 'Cursive',
    scripts: ['latin'],
    license: 'OFL-1.1',
    connected: true,
  },
  { id: 'gochi-hand', family: 'Gochi Hand', label: 'Gochi', note: 'Thick marker', group: 'Bold hand', scripts: ['latin'], license: 'OFL-1.1' },
  { id: 'rock-salt', family: 'Rock Salt', label: 'Rock Salt', note: 'Heavy, pressed hard', group: 'Bold hand', scripts: ['latin'], license: 'Apache-2.0' },
  { id: 'neucha', family: 'Neucha', label: 'Neucha', note: 'Cyrillic and Latin print', group: 'World scripts', scripts: ['latin', 'cyrillic'], license: 'OFL-1.1' },
  {
    id: 'nanum-pen-script',
    family: 'Nanum Pen Script',
    label: 'Nanum Pen',
    note: 'Korean pen hand',
    group: 'World scripts',
    scripts: ['latin', 'hangul'],
    license: 'OFL-1.1',
  },
  {
    id: 'yomogi',
    family: 'Yomogi',
    label: 'Yomogi',
    note: 'Japanese pen hand',
    group: 'World scripts',
    scripts: ['latin', 'cyrillic', 'kana', 'han'],
    license: 'OFL-1.1',
  },
  {
    id: 'ma-shan-zheng',
    family: 'Ma Shan Zheng',
    label: 'Ma Shan Zheng',
    note: 'Chinese brush hand',
    group: 'World scripts',
    scripts: ['latin', 'han'],
    license: 'OFL-1.1',
  },
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
let handFonts: FontEntry[] = [];

/** Offer these hands of your own at the top of the gallery. */
export function setOwnHands(hands: BuiltHand[]): void {
  handFonts = hands.map((hand) => ({
    id: `hand:${hand.id}`,
    family: hand.standIn,
    label: hand.name,
    note: `${hand.name} · ${hand.written} ${hand.written === 1 ? 'letter' : 'letters'}`,
    group: 'Your hands',
    scripts: ['latin'],
    license: 'Your own',
    hand,
  }));
}

export function allFonts(): FontEntry[] {
  return [...handFonts, ...customFonts, ...FONTS];
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
  // A custom font may not cover the basic Latin set; keep a hand behind it.
  if (font.custom) families.push('Caveat');
  return families;
}

export function cssFontStack(families: string[]): string {
  return [...families.map((f) => `"${f.replace(/["\\]/g, '')}"`), 'cursive'].join(', ');
}

/** Make sure every font subset the text needs is downloaded before drawing. */
export async function loadFonts(families: string[], text: string): Promise<void> {
  await loadFontCss(families);
  // x and H are always needed: they are measured to size each font.
  const chars = new Set<string>(['x', 'H']);
  for (const ch of text) {
    chars.add(ch);
    if (chars.size > 6000) break;
  }
  const sample = [...chars].join('') || 'abc';
  await Promise.all(families.map((family) => document.fonts.load(`32px "${family}"`, sample).catch(() => [])));
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
  const buffer = await file.arrayBuffer();
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
  // Its outlines too, so its letters can be bent like any other hand's.
  await registerOutlines(family, buffer.slice(0));
  metricCache.delete(family);
  const entry: FontEntry = {
    id: `custom:${family}`,
    family,
    label: name,
    note: 'Your own font',
    group: 'Your fonts',
    scripts: ['latin'],
    license: 'Supplied by you',
    custom: true,
  };
  customFonts.unshift(entry);
  return entry;
}
