import type { Settings } from './types';

export const SAMPLE_TEXT = `Dear Maya,

Thank you so much for the weekend at the lake. I still can't believe we saw an otter right next to the dock, and I think about your lemon cake at least twice a day.

The seeds you gave me are already sprouting on the windowsill. The basil is winning, the tomatoes are catching up, and the mint is plotting something.

Let's do it again in the spring. I'll bring the board games this time, and I promise to lose gracefully.

With love,
Sam`;

export const DEFAULT_SETTINGS: Settings = {
  text: SAMPLE_TEXT,
  fontId: 'caveat',
  letterSize: 0.36,
  slant: 0,
  letterSpacing: 0,
  wordSpacing: 1,
  inkColor: '#1d3b8f',
  pen: 'ballpoint',

  paperSize: 'a4',
  landscape: false,
  paperStyle: 'ruled',
  lineSpacing: 8,
  paperColor: '#fdfcf7',
  ruleColor: '#8fb1dc',
  marginLine: true,
  margins: { top: 20, right: 12, bottom: 12, left: 28 },
  texture: true,
  scanEffect: false,

  messiness: 0.5,
  jitter: {
    baseline: 1,
    rotation: 1,
    scale: 1,
    spacing: 1,
    lineSlope: 1,
    indent: 1,
    fatigue: 1,
    ink: 1,
  },
  seed: 20260923,
};

/** Merge stored or partial settings over the defaults, dropping unknown keys. */
export function withDefaults(partial: unknown): Settings {
  const base: Settings = structuredClone(DEFAULT_SETTINGS);
  if (!partial || typeof partial !== 'object') return base;
  const src = partial as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof Settings)[]) {
    const value = src[key];
    const def = base[key];
    if (value === undefined || value === null) continue;
    if (typeof def === 'object') {
      if (typeof value === 'object') {
        for (const sub of Object.keys(def)) {
          const v = (value as Record<string, unknown>)[sub];
          if (typeof v === typeof (def as unknown as Record<string, unknown>)[sub]) {
            (def as unknown as Record<string, unknown>)[sub] = v;
          }
        }
      }
    } else if (typeof value === typeof def) {
      (base as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return base;
}
