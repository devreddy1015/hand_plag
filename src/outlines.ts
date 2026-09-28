/**
 * Letter outlines, read from the font files themselves (browser only).
 *
 * The browser will draw a font for us, but only as the font designer drew
 * it: every "a" the same "a". To bend each copy into its own shape the
 * engine needs the outline itself, so the font's WOFF files are read here
 * with opentype.js — the same files the browser already uses, one per
 * unicode subset, fetched only for the hand that is chosen.
 *
 * Anything without an outline (a subset that is not bundled, a WOFF2 font
 * someone uploaded, a script that needs shaping) is still drawn by the
 * browser; it just is not bent.
 */
import type { Font } from 'opentype.js';
import { OutlineBuilder, type Outline } from './engine';

type UrlLoader = () => Promise<{ default: string }>;

/** The WOFF files behind each bundled hand, one per unicode subset. */
const FILES: Record<string, UrlLoader[]> = {
  'Caveat': [
    () => import('@fontsource/caveat/files/caveat-latin-400-normal.woff?url'),
    () => import('@fontsource/caveat/files/caveat-latin-ext-400-normal.woff?url'),
    () => import('@fontsource/caveat/files/caveat-cyrillic-400-normal.woff?url'),
    () => import('@fontsource/caveat/files/caveat-cyrillic-ext-400-normal.woff?url'),
  ],
  'Kalam': [
    () => import('@fontsource/kalam/files/kalam-latin-400-normal.woff?url'),
    () => import('@fontsource/kalam/files/kalam-latin-ext-400-normal.woff?url'),
  ],
  'Architects Daughter': [
    () => import('@fontsource/architects-daughter/files/architects-daughter-latin-400-normal.woff?url'),
    () => import('@fontsource/architects-daughter/files/architects-daughter-latin-ext-400-normal.woff?url'),
  ],
  'Covered By Your Grace': [
    () => import('@fontsource/covered-by-your-grace/files/covered-by-your-grace-latin-400-normal.woff?url'),
    () => import('@fontsource/covered-by-your-grace/files/covered-by-your-grace-latin-ext-400-normal.woff?url'),
  ],
  'Indie Flower': [
    () => import('@fontsource/indie-flower/files/indie-flower-latin-400-normal.woff?url'),
    () => import('@fontsource/indie-flower/files/indie-flower-latin-ext-400-normal.woff?url'),
  ],
  'Shadows Into Light': [
    () => import('@fontsource/shadows-into-light/files/shadows-into-light-latin-400-normal.woff?url'),
    () => import('@fontsource/shadows-into-light/files/shadows-into-light-latin-ext-400-normal.woff?url'),
  ],
  'Patrick Hand': [
    () => import('@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff?url'),
    () => import('@fontsource/patrick-hand/files/patrick-hand-latin-ext-400-normal.woff?url'),
    () => import('@fontsource/patrick-hand/files/patrick-hand-vietnamese-400-normal.woff?url'),
  ],
  'Just Another Hand': [
    () => import('@fontsource/just-another-hand/files/just-another-hand-latin-400-normal.woff?url'),
    () => import('@fontsource/just-another-hand/files/just-another-hand-latin-ext-400-normal.woff?url'),
  ],
  'Gochi Hand': [() => import('@fontsource/gochi-hand/files/gochi-hand-latin-400-normal.woff?url')],
  'Rock Salt': [() => import('@fontsource/rock-salt/files/rock-salt-latin-400-normal.woff?url')],
  'Reenie Beanie': [() => import('@fontsource/reenie-beanie/files/reenie-beanie-latin-400-normal.woff?url')],
  'Homemade Apple': [() => import('@fontsource/homemade-apple/files/homemade-apple-latin-400-normal.woff?url')],
  'Cedarville Cursive': [() => import('@fontsource/cedarville-cursive/files/cedarville-cursive-latin-400-normal.woff?url')],
  'Zeyada': [
    () => import('@fontsource/zeyada/files/zeyada-latin-400-normal.woff?url'),
    () => import('@fontsource/zeyada/files/zeyada-latin-ext-400-normal.woff?url'),
  ],
  'Dawning of a New Day': [() => import('@fontsource/dawning-of-a-new-day/files/dawning-of-a-new-day-latin-400-normal.woff?url')],
  'Neucha': [
    () => import('@fontsource/neucha/files/neucha-latin-400-normal.woff?url'),
    () => import('@fontsource/neucha/files/neucha-cyrillic-400-normal.woff?url'),
  ],
  'Nanum Pen Script': [() => import('@fontsource/nanum-pen-script/files/nanum-pen-script-latin-400-normal.woff?url')],
  'Yomogi': [
    () => import('@fontsource/yomogi/files/yomogi-latin-400-normal.woff?url'),
    () => import('@fontsource/yomogi/files/yomogi-latin-ext-400-normal.woff?url'),
    () => import('@fontsource/yomogi/files/yomogi-cyrillic-400-normal.woff?url'),
    () => import('@fontsource/yomogi/files/yomogi-vietnamese-400-normal.woff?url'),
  ],
  'Ma Shan Zheng': [() => import('@fontsource/ma-shan-zheng/files/ma-shan-zheng-latin-400-normal.woff?url')],
  'Aref Ruqaa': [
    () => import('@fontsource/aref-ruqaa/files/aref-ruqaa-latin-400-normal.woff?url'),
    () => import('@fontsource/aref-ruqaa/files/aref-ruqaa-latin-ext-400-normal.woff?url'),
  ],
};

/** One hand's outlines, across every subset file it came in. */
export interface OutlineFont {
  /** The outline of a single character, in em units, or null if the hand has none. */
  outline(unit: string): Outline | null;
  /** Whether the hand has a letter for this character at all. */
  has(unit: string): boolean;
}

const loaded = new Map<string, Promise<OutlineFont | null>>();

let parser: Promise<typeof import('opentype.js')> | null = null;
function opentype(): Promise<typeof import('opentype.js')> {
  parser ??= import('opentype.js');
  return parser;
}

/** Read the outlines of a bundled hand. Resolves to null if they cannot be had. */
export function loadOutlines(family: string): Promise<OutlineFont | null> {
  let pending = loaded.get(family);
  if (!pending) {
    pending = readBundled(family).catch((err) => {
      console.warn('Letter outlines unavailable for', family, err);
      return null;
    });
    loaded.set(family, pending);
  }
  return pending;
}

/** Keep the outlines of a font someone uploaded. WOFF2 cannot be read, and is drawn plain. */
export function registerOutlines(family: string, buffer: ArrayBuffer): Promise<OutlineFont | null> {
  const pending = opentype()
    .then(({ parse }) => fromFonts([parse(buffer)]))
    .catch(() => null);
  loaded.set(family, pending);
  return pending;
}

async function readBundled(family: string): Promise<OutlineFont | null> {
  const files = FILES[family];
  if (!files) return null;
  const [{ parse }, buffers] = await Promise.all([
    opentype(),
    Promise.all(
      files.map(async (load) => {
        const url = (await load()).default;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} for ${url}`);
        return response.arrayBuffer();
      }),
    ),
  ]);
  return fromFonts(buffers.map((buffer) => parse(buffer)));
}

function fromFonts(fonts: Font[]): OutlineFont {
  const cache = new Map<string, Outline | null>();
  const owner = (ch: string): Font | undefined => fonts.find((font) => font.hasChar(ch));

  const single = (unit: string): string | null => {
    const composed = unit.normalize('NFC');
    // One code point only: a cluster built from combining marks needs the
    // browser's shaping to put the marks in the right place.
    const points = [...composed];
    return points.length === 1 ? points[0] : null;
  };

  return {
    has(unit) {
      const ch = single(unit);
      if (ch === null) return fonts.length > 0 && [...unit].every((c) => owner(c) !== undefined);
      return owner(ch) !== undefined;
    },
    outline(unit) {
      let hit = cache.get(unit);
      if (hit !== undefined) return hit;
      hit = null;
      const ch = single(unit);
      const font = ch === null ? undefined : owner(ch);
      if (ch !== null && font) {
        const path = font.charToGlyph(ch).getPath(0, 0, 1);
        const b = new OutlineBuilder();
        for (const c of path.commands) {
          if (c.type === 'M') b.moveTo(c.x!, c.y!);
          else if (c.type === 'L') b.lineTo(c.x!, c.y!);
          else if (c.type === 'Q') b.quadTo(c.x1!, c.y1!, c.x!, c.y!);
          else if (c.type === 'C') b.cubicTo(c.x1!, c.y1!, c.x2!, c.y2!, c.x!, c.y!);
          else b.close();
        }
        // A space has no outline, and should not be drawn as a fallback either.
        hit = b.done();
      }
      cache.set(unit, hit);
      return hit;
    },
  };
}
