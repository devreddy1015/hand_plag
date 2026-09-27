import { DEFAULT_FEATURES } from './templates';
import type { FinishLook, Holes, MarginRule, PageNumberMode, PaperStyle, PenType, Settings } from './types';

export const SAMPLE_TEXT = `# Photosynthesis

Photosynthesis is the process by which green plants, algae and some bacteria turn light energy into chemical energy stored as sugar. It happens in the chloroplasts, where the pigment chlorophyll absorbs light most strongly in the blue and red parts of the spectrum.

## The two stages

1. The **light reactions** split water, release oxygen, and store energy in ATP and NADPH.
2. The **Calvin cycle** uses that energy to fix carbon dioxide into a three-carbon sugar, which the plant builds into glucose, starch and cellulose.

## Why it matters

- Almost every food chain begins with a photosynthetic organism.
- The oxygen in the atmosphere is there because of it.
- The coal and oil we burn are ancient sunlight, captured this way.

Without photosynthesis the atmosphere would hold almost no free oxygen, and complex life as we know it could not exist. That is a large claim to rest on one reaction, but the geological record supports it: free oxygen appears in the rocks only after the organisms that make it do.`

export const DEFAULT_SETTINGS: Settings = {
  text: SAMPLE_TEXT,
  markdown: true,
  fontId: 'caveat',
  letterSize: 0.36,
  slant: 0,
  letterSpacing: 0,
  wordSpacing: 1,
  lineFill: 0.6,
  paragraphIndent: 0,
  inkColor: '#1d3b8f',
  pen: 'ballpoint',
  inkWeight: 1,

  paperSize: 'a4',
  landscape: false,
  paperStyle: 'ruled',
  template: 'notebook',
  lineSpacing: 8,
  paperColor: '#fdfcf7',
  ruleColor: '#93b4dd',
  marginColor: '#d9634f',
  margins: { top: 20, right: 12, bottom: 14, left: 28 },
  features: { ...DEFAULT_FEATURES },
  texture: true,
  finish: 'none',

  messiness: 0.5,
  corrections: 0.12,
  jitter: {
    baseline: 1,
    rotation: 1,
    scale: 1,
    spacing: 1,
    lineSlope: 1,
    indent: 1,
    fatigue: 1,
    ink: 1,
    drift: 1,
    word: 1,
  },
  seed: 20260923,
};

const PAPER_STYLES: PaperStyle[] = ['plain', 'ruled', 'grid', 'dotted', 'four-line', 'seyes'];
const PENS: PenType[] = ['ballpoint', 'gel', 'rollerball', 'fountain', 'calligraphy', 'felt', 'pencil'];
const FINISHES: FinishLook[] = ['none', 'scan', 'photo'];
const MARGIN_RULES: MarginRule[] = ['none', 'single', 'double', 'box'];
const HOLES: Holes[] = ['none', 'punch2', 'punch3', 'spiral'];
const PAGE_NUMBERS: PageNumberMode[] = ['none', 'printed', 'handwritten'];

/** Enumerated fields, so a stale saved setting can never reach the engine. */
const ENUMS: Record<string, readonly string[]> = {
  paperStyle: PAPER_STYLES,
  pen: PENS,
  finish: FINISHES,
  'features.marginRule': MARGIN_RULES,
  'features.holes': HOLES,
  'features.pageNumber': PAGE_NUMBERS,
};

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const COLOR_KEYS = new Set(['inkColor', 'paperColor', 'ruleColor', 'marginColor']);

/** Merge stored or partial settings over the defaults, dropping anything invalid. */
export function withDefaults(partial: unknown): Settings {
  const base: Settings = structuredClone(DEFAULT_SETTINGS);
  if (!partial || typeof partial !== 'object') return base;
  const src = partial as Record<string, unknown>;

  const accept = (path: string, def: unknown, value: unknown): unknown => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== typeof def) return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    const allowed = ENUMS[path];
    if (allowed && !allowed.includes(String(value))) return undefined;
    if (COLOR_KEYS.has(path) && !COLOR.test(String(value))) return undefined;
    return value;
  };

  for (const key of Object.keys(base) as (keyof Settings)[]) {
    const value = src[key];
    const def = base[key];
    if (value === undefined || value === null) continue;
    if (def !== null && typeof def === 'object') {
      if (typeof value !== 'object') continue;
      const target = def as unknown as Record<string, unknown>;
      const from = value as Record<string, unknown>;
      for (const sub of Object.keys(target)) {
        const next = accept(`${key}.${sub}`, target[sub], from[sub]);
        if (next !== undefined) target[sub] = next;
      }
    } else {
      const next = accept(key, def, value);
      if (next !== undefined) (base as unknown as Record<string, unknown>)[key] = next;
    }
  }

  // Columns is the one number that has to be one of two values.
  base.features.columns = base.features.columns === 2 ? 2 : 1;
  return base;
}
