import { clamp, createNoise1D, gaussian, hashInts, hashString, mulberry32, type Rng } from './random';
import { isRtlParagraph, tokenize, type Token } from './segment';
import type { DocumentLayout, Measurer, PageGeometry, PageLayout, PlacedGlyph, Settings } from './types';

/** A line containing only this marker starts a new page. */
export const PAGE_BREAK = /^\s*\[\[page\]\]\s*$/i;

const DEG = Math.PI / 180;

/**
 * Jitter amplitudes (one standard deviation) at messiness 0.5 with every
 * weight at 1. Lengths are fractions of the line spacing or font size so
 * the look stays the same at any paper size or resolution.
 */
const BASE = {
  baselineRandom: 0.02, // × line spacing
  baselineWave: 0.035, // × line spacing
  rotationDeg: 1.6,
  scale: 0.03,
  letterGap: 0.018, // × font size
  wordGap: 0.18, // × space width
  slopeDeg: 0.25,
  indent: 0.14, // × line spacing
  slantDriftDeg: 2.5,
  slantRandomDeg: 1.4,
  personaSkewDeg: 3,
  personaScale: 0.035,
  personaRotDeg: 1.2,
  personaBaseline: 0.012, // × line spacing
};

/** How far the written baseline sits above the printed rule. */
const BASELINE_LIFT = 0.06; // × line spacing

/** How much each pen varies in ink flow. */
export const PEN_INK_VARIATION: Record<Settings['pen'], number> = {
  ballpoint: 0.22,
  gel: 0.1,
  fountain: 0.32,
  pencil: 0.3,
};

interface Unit {
  text: string;
  /** Drawn width. */
  width: number;
  /** Distance to the next unit of the same word. */
  advance: number;
  scaleX: number;
  scaleY: number;
  /** Unit normal samples, scaled at placement (so fatigue can grow them). */
  nBaseline: number;
  nRotation: number;
  nSlant: number;
  /** Fixed offsets from this letter's "persona" variant. */
  pSkew: number;
  pRotation: number;
  pBaseline: number;
  shade: number;
}

interface Word {
  units: Unit[];
  width: number;
  /** Gap before this word when it is not first on its line. */
  gap: number;
  spacesBefore: number;
}

interface Persona {
  skew: number;
  scale: number;
  rotation: number;
  baseline: number;
}

export interface LayoutOptions {
  /**
   * The font joins its letters (connected cursive). Per-letter jitter is
   * damped so joins still meet; line-level drift is unchanged.
   */
  connected?: boolean;
  /**
   * Size factor for a unit. Lets characters drawn by a fallback font (say,
   * Devanagari inside a Latin font) match the main font's letter size.
   */
  unitScale?: (unit: string) => number;
}

/**
 * Lay out text into pages of placed glyphs. Pure given the measurer: no
 * canvas, no DOM, so it runs in tests, workers or on a server.
 */
export function layoutDocument(
  text: string,
  geometry: PageGeometry,
  fontPx: number,
  s: Settings,
  measure: Measurer,
  options: LayoutOptions = {},
): DocumentLayout {
  const m = clamp(s.messiness, 0, 1) * 2;
  const w = s.jitter;
  const spacing = geometry.spacing;
  /** Scale for jitter that moves single letters relative to their neighbours. */
  const k = options.connected ? 0.35 : 1;

  const amp = {
    baseline: BASE.baselineRandom * spacing * m * w.baseline * k,
    wave: BASE.baselineWave * spacing * m * w.baseline,
    rotation: BASE.rotationDeg * DEG * m * w.rotation * k,
    scale: BASE.scale * m * w.scale * k,
    letterGap: BASE.letterGap * fontPx * m * w.spacing * k,
    wordGap: BASE.wordGap * m * w.spacing,
    slope: BASE.slopeDeg * DEG * m * w.lineSlope,
    indent: BASE.indent * spacing * m * w.indent,
    slantDrift: BASE.slantDriftDeg * m * w.rotation,
    slantRandom: BASE.slantRandomDeg * m * w.rotation * k,
    ink: (PEN_INK_VARIATION[s.pen] ?? 0.2) * clamp(w.ink, 0, 2),
  };

  const widthCache = new Map<string, number>();
  const width = (str: string): number => {
    let v = widthCache.get(str);
    if (v === undefined) {
      v = measure(str);
      widthCache.set(str, v);
    }
    return v;
  };
  /** Advance of `a` when followed by `b`, keeping the font's kerning. */
  const kernAdvance = (a: string, b: string | undefined): number =>
    b === undefined ? width(a) : width(a + b) - width(b);

  const personas = new Map<string, Persona>();
  const personaFor = (cluster: string, variant: number): Persona => {
    const key = `${variant}|${cluster}`;
    let p = personas.get(key);
    if (!p) {
      const r = mulberry32(hashInts(s.seed, hashString(cluster), variant, 0x7e75));
      p = {
        skew: Math.tan(gaussian(r) * BASE.personaSkewDeg * DEG * m * w.rotation * k),
        scale: gaussian(r) * BASE.personaScale * m * w.scale * k,
        rotation: gaussian(r) * BASE.personaRotDeg * DEG * m * w.rotation * k,
        baseline: gaussian(r) * BASE.personaBaseline * spacing * m * w.baseline * k,
      };
      personas.set(key, p);
    }
    return p;
  };

  const letterSpacing = s.letterSpacing * fontPx;
  const spaceWidth = Math.max(width(' '), fontPx * 0.2) * s.wordSpacing;

  const unitScale = options.unitScale ?? (() => 1);

  const buildWord = (token: Token, rng: Rng): Word => {
    const wordShade = gaussian(rng) * 0.35;
    const shadeOf = () => clamp((wordShade + gaussian(rng) * 0.15) * clamp(w.ink, 0, 2), -1, 1);
    const units: Unit[] = [];

    if (token.shaped) {
      const text = token.units[0];
      const sc = (1 + gaussian(rng) * amp.scale * 0.6) * unitScale(text);
      const wd = width(text) * sc;
      units.push({
        text,
        width: wd,
        advance: wd,
        scaleX: sc,
        scaleY: sc,
        nBaseline: gaussian(rng),
        nRotation: gaussian(rng) * 0.4,
        nSlant: gaussian(rng) * 0.4,
        pSkew: 0,
        pRotation: 0,
        pBaseline: 0,
        shade: shadeOf(),
      });
    } else {
      const n = token.units.length;
      for (let i = 0; i < n; i++) {
        const c = token.units[i];
        const next = i + 1 < n ? token.units[i + 1] : undefined;
        const persona = personaFor(c, Math.floor(rng() * 3));
        const sy = Math.max(0.7, 1 + gaussian(rng) * amp.scale + persona.scale) * unitScale(c);
        const sx = sy * (1 + gaussian(rng) * amp.scale * 0.3);
        const drawn = width(c) * sx;
        const base = kernAdvance(c, next) * sx;
        const gapJitter = clamp(gaussian(rng), -2, 2) * amp.letterGap;
        const advance = next === undefined ? drawn : Math.max(base * 0.6, base + letterSpacing + gapJitter);
        units.push({
          text: c,
          width: drawn,
          advance,
          scaleX: sx,
          scaleY: sy,
          nBaseline: gaussian(rng),
          nRotation: gaussian(rng),
          nSlant: gaussian(rng),
          pSkew: persona.skew,
          pRotation: persona.rotation,
          pBaseline: persona.baseline,
          shade: shadeOf(),
        });
      }
    }

    const gap =
      token.spacesBefore > 0
        ? Math.max(spaceWidth * 0.4, token.spacesBefore * spaceWidth * (1 + gaussian(rng) * amp.wordGap))
        : Math.max(0, letterSpacing + gaussian(rng) * amp.letterGap);
    return { units, width: wordWidth(units), gap, spacesBefore: token.spacesBefore };
  };

  const fullWidth = geometry.textRight - geometry.textLeft;
  const maxIndent = amp.indent * 3;
  const splitLimit = Math.max(fontPx, fullWidth - maxIndent);

  const pages: PageLayout[] = [{ index: 0, glyphs: [] }];
  const linesPerPage = geometry.textLines.length;
  let lineOnPage = 0;
  let globalLine = 0;

  const baselineNoise = createNoise1D(hashInts(s.seed, 0xba5e));
  const slantNoise = createNoise1D(hashInts(s.seed, 0x51a7));
  const inkNoise = createNoise1D(hashInts(s.seed, 0x1c4));
  const pressureNoise = createNoise1D(hashInts(s.seed, 0x9e55));

  const takeLine = (): { page: PageLayout; line: number } => {
    if (lineOnPage >= linesPerPage) {
      pages.push({ index: pages.length, glyphs: [] });
      lineOnPage = 0;
    }
    const slot = { page: pages[pages.length - 1], line: lineOnPage };
    lineOnPage++;
    return slot;
  };

  const placeLine = (items: { word: Word; gap: number }[], indent: number, slope: number, rtl: boolean) => {
    const { page, line } = takeLine();
    const lineNoise = globalLine * 37.17;
    globalLine++;
    const fatigue = 1 + clamp(w.fatigue, 0, 3) * 0.8 * (linesPerPage > 1 ? line / (linesPerPage - 1) : 0);
    const baseY = geometry.textLines[line] - BASELINE_LIFT * spacing;
    const startX = geometry.textLeft + indent;
    const tanSlope = Math.tan(slope);
    let x = startX;

    for (const { word, gap } of items) {
      x += gap;
      for (const u of word.units) {
        const rel = x - startX;
        const wave = baselineNoise(rel / (spacing * 2.5) + lineNoise) * amp.wave;
        const y = baseY + rel * tanSlope + wave + u.nBaseline * amp.baseline * fatigue + u.pBaseline;
        const slantDeg =
          s.slant + slantNoise(rel / (spacing * 4) + lineNoise) * amp.slantDrift + u.nSlant * amp.slantRandom * fatigue;
        const t = (rel + lineNoise * 40) / (fontPx * 5);
        const glyph: PlacedGlyph = {
          text: u.text,
          x: rtl ? geometry.textLeft + geometry.textRight - x - u.width : x,
          y,
          rotation: slope + u.nRotation * amp.rotation * fatigue + u.pRotation,
          skew: Math.tan(clamp(slantDeg, -45, 45) * DEG) + u.pSkew,
          scaleX: u.scaleX,
          scaleY: u.scaleY,
          opacity: clamp(1 - amp.ink * (0.5 + 0.5 * inkNoise(t)), 0.15, 1),
          pressure: clamp(0.5 + 0.5 * pressureNoise(t * 0.7 + 11), 0, 1),
          shade: u.shade,
        };
        if (rtl) glyph.rtl = true;
        page.glyphs.push(glyph);
        x += u.advance;
      }
    }
  };

  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  paragraphs.forEach((paragraph, pi) => {
    if (PAGE_BREAK.test(paragraph)) {
      if (lineOnPage > 0) lineOnPage = linesPerPage;
      return;
    }
    const rtl = isRtlParagraph(paragraph);
    const tokens = tokenize(paragraph, rtl);
    if (tokens.length === 0) {
      takeLine();
      globalLine++;
      return;
    }

    const words: Word[] = [];
    tokens.forEach((token, wi) => {
      const word = buildWord(token, mulberry32(hashInts(s.seed, pi, wi)));
      if (word.width > splitLimit && word.units.length > 1) words.push(...splitWord(word, splitLimit));
      else words.push(word);
    });

    let li = 0;
    const lineParams = (index: number) => {
      const r = mulberry32(hashInts(s.seed, 0x11e, pi, index));
      return {
        indent: Math.min(maxIndent, Math.abs(gaussian(r)) * amp.indent),
        slope: clamp(gaussian(r), -2, 2) * amp.slope,
      };
    };

    let params = lineParams(li);
    let items: { word: Word; gap: number }[] = [];
    let x = 0;
    for (const word of words) {
      const avail = fullWidth - params.indent;
      if (items.length === 0) {
        // Leading spaces on a paragraph's first line act as an indent.
        const lead = li === 0 && word.spacesBefore > 0 ? Math.min(word.gap, avail * 0.5) : 0;
        items.push({ word, gap: lead });
        x = lead + word.width;
      } else if (x + word.gap + word.width <= avail) {
        items.push({ word, gap: word.gap });
        x += word.gap + word.width;
      } else {
        placeLine(items, params.indent, params.slope, rtl);
        li++;
        params = lineParams(li);
        items = [{ word, gap: 0 }];
        x = word.width;
      }
    }
    if (items.length > 0) placeLine(items, params.indent, params.slope, rtl);
  });

  while (pages.length > 1 && pages[pages.length - 1].glyphs.length === 0) pages.pop();

  return { geometry, fontPx, pages };
}

function wordWidth(units: Unit[]): number {
  let total = 0;
  for (let i = 0; i < units.length; i++) total += i === units.length - 1 ? units[i].width : units[i].advance;
  return total;
}

/** Break a word that is wider than a line into line-sized chunks. */
function splitWord(word: Word, limit: number): Word[] {
  const chunks: Word[] = [];
  let current: Unit[] = [];
  let advances = 0; // sum of advances of `current`
  const flush = () => {
    const first = chunks.length === 0;
    chunks.push({
      units: current,
      width: wordWidth(current),
      gap: first ? word.gap : 0,
      spacesBefore: first ? word.spacesBefore : 0,
    });
  };
  for (const unit of word.units) {
    if (current.length > 0 && advances + unit.width > limit) {
      flush();
      current = [];
      advances = 0;
    }
    current.push(unit);
    advances += unit.advance;
  }
  if (current.length > 0) flush();
  return chunks;
}
