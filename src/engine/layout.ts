import { EM_BOLD, EM_ITALIC, EM_UNDERLINE, parseBlocks, type Block } from './markup';
import { clamp, createDrift, createNoise1D, gaussian, hashInts, hashString, mulberry32, smoothstep, type Rng } from './random';
import { gapAfterFactor, gapBeforeFactor, hyphenPoint, isRtlParagraph, tokenize, type Token } from './segment';
import type { DocumentLayout, InkStroke, Measurer, PageGeometry, PageLayout, PlacedGlyph, Settings, TextArea } from './types';

export { PAGE_BREAK } from './markup';

const DEG = Math.PI / 180;

/** Never lay out more than this; a runaway document would freeze the tab. */
const MAX_PAGES = 4000;

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
  // Whole-word offsets: a writer is consistent inside a word, less so between words.
  wordBaseline: 0.03, // × line spacing
  wordSlantDeg: 1.1,
  wordScale: 0.022,
  // Slow drift over many lines (the hand settling, tiring, speeding up).
  driftScale: 0.035,
  driftSlantDeg: 1.8,
  driftSpacing: 0.06,
  driftBaseline: 0.05, // × line spacing, unruled paper only
};

/** How far the written baseline sits above the printed rule. */
const BASELINE_LIFT = 0.06; // × line spacing

/** Letter variants per cluster: more variants, less obvious repetition. */
const PERSONA_VARIANTS = 5;

/** How much each pen varies in ink flow. */
export const PEN_INK_VARIATION: Record<Settings['pen'], number> = {
  ballpoint: 0.22,
  gel: 0.1,
  rollerball: 0.14,
  fountain: 0.32,
  calligraphy: 0.28,
  felt: 0.12,
  pencil: 0.3,
};

/** Relative size of each heading level, and whether the writer underlines it. */
const HEADING_STYLE: Record<number, { scale: number; underline: boolean }> = {
  1: { scale: 1.5, underline: true },
  2: { scale: 1.28, underline: true },
  3: { scale: 1.12, underline: false },
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
  /** Emphasis bits from the markup. */
  em: number;
}

interface Word {
  units: Unit[];
  width: number;
  /** Gap before this word when it is not first on its line. */
  gap: number;
  spacesBefore: number;
  /** Whole-word offsets: the hand is steady inside a word. */
  baseline: number;
  slant: number;
  /** Ink pooled where the pen was set down for this word. */
  blot: number;
  /** Letters written, crossed out and started again before this word. */
  falseStart: Unit[];
  /** Squeezed in above the line with a caret, as a writer does when a word is missed. */
  inserted: boolean;
  em: number;
}

interface Persona {
  skew: number;
  scale: number;
  rotation: number;
  baseline: number;
}

interface LineItem {
  word: Word;
  gap: number;
}

interface Line {
  items: LineItem[];
  /** Extra offset from the left of the area (ragged edge, indents, hanging text). */
  indent: number;
  /** Multiplier on every advance, 1 or slightly below, when the writer crams. */
  squeeze: number;
  /** Rule slots the line occupies (big headings take two). */
  slots: number;
  /** Underline the whole line (headings). */
  underline: boolean;
  /** Draw a bullet dot at the left of the line. */
  bullet: boolean;
  /** Centre the line in the column, as a caption sits under its figure. */
  center: boolean;
  /** Font size of this line's letters, for strokes drawn around them. */
  fontPx: number;
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
  /**
   * Natural size of a diagram, in whatever units, so the layout can work out
   * its shape. Returning null leaves room for a figure nobody has drawn yet.
   */
  imageSize?: (src: string) => { width: number; height: number; widthUnits?: number } | null;
}

/**
 * Lay out text into pages of placed glyphs and pen strokes. Pure given the
 * measurer: no canvas, no DOM, so it runs in tests, workers or on a server.
 */
export function layoutDocument(
  text: string,
  geometryOf: (pageIndex: number) => PageGeometry,
  fontPx: number,
  s: Settings,
  measure: Measurer,
  options: LayoutOptions = {},
): DocumentLayout {
  const m = clamp(s.messiness, 0, 1) * 2;
  const w = s.jitter;
  const geom0 = geometryOf(0);
  const spacing = geom0.spacing;
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
    wordBaseline: BASE.wordBaseline * spacing * m * w.word,
    wordSlant: BASE.wordSlantDeg * m * w.word,
    wordScale: BASE.wordScale * m * w.word,
    ink: (PEN_INK_VARIATION[s.pen] ?? 0.2) * clamp(w.ink, 0, 2),
  };
  // At messiness 0 the hand is a machine: no drift at all.
  const driftAmp = clamp(w.drift, 0, 3) * m * 0.75;

  // ------------------------------------------------------------ measurement

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

  const unitScale = options.unitScale ?? (() => 1);
  const baseSpaceWidth = Math.max(width(' '), fontPx * 0.2) * s.wordSpacing;

  // ------------------------------------------------------------ word building

  /**
   * Build one drawable word. `sizeRatio` scales headings; advances come from
   * the font's own kerning so pairs still sit correctly when letters jitter.
   */
  const buildWord = (token: Token, rng: Rng, emAt: (offset: number) => number, sizeRatio: number): Word => {
    // Sampled first so it is part of every width this word reports.
    const wordScale = 1 + gaussian(rng) * amp.wordScale;
    const wordShade = gaussian(rng) * 0.35;
    const shadeOf = () => clamp((wordShade + gaussian(rng) * 0.15) * clamp(w.ink, 0, 2), -1, 1);
    const letterSpacing = s.letterSpacing * fontPx * sizeRatio;
    const units: Unit[] = [];
    let em = 0;

    if (token.shaped) {
      const text = token.units[0];
      em = emAt(token.offset);
      const sc = (1 + gaussian(rng) * amp.scale * 0.6) * unitScale(text) * sizeRatio * emScale(em) * wordScale;
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
        em,
      });
    } else {
      const n = token.units.length;
      let offset = token.offset;
      for (let i = 0; i < n; i++) {
        const c = token.units[i];
        const next = i + 1 < n ? token.units[i + 1] : undefined;
        const bits = emAt(offset);
        em |= bits;
        offset += c.length;
        const persona = personaFor(c, Math.floor(rng() * PERSONA_VARIANTS));
        const size = sizeRatio * emScale(bits) * wordScale;
        const sy = Math.max(0.7, 1 + gaussian(rng) * amp.scale + persona.scale) * unitScale(c) * size;
        const sx = sy * (1 + gaussian(rng) * amp.scale * 0.3);
        const drawn = width(c) * sx;
        const base = kernAdvance(c, next) * sx;
        const gapJitter = clamp(gaussian(rng), -2, 2) * amp.letterGap;
        const advance = next === undefined ? drawn : Math.max(base * 0.88, base + letterSpacing + gapJitter);
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
          em: bits,
        });
      }
    }

    const spaceWidth = baseSpaceWidth * sizeRatio;
    const gap =
      token.spacesBefore > 0
        ? Math.max(spaceWidth * 0.4, token.spacesBefore * spaceWidth * (1 + gaussian(rng) * amp.wordGap))
        : Math.max(0, letterSpacing + gaussian(rng) * amp.letterGap);

    const word: Word = {
      units,
      width: wordWidth(units),
      gap,
      spacesBefore: token.spacesBefore,
      baseline: gaussian(rng) * amp.wordBaseline,
      slant: gaussian(rng) * amp.wordSlant,
      blot: rng() < 0.12 ? rng() : 0,
      falseStart: [],
      inserted: false,
      em,
    };
    return word;
  };

  /** Letters the writer started, crossed out, and wrote again. */
  const addFalseStart = (word: Word, rng: Rng): void => {
    const count = Math.min(word.units.length - 1, 1 + Math.floor(rng() * 3));
    if (count < 1) return;
    word.falseStart = word.units.slice(0, count).map((u) => ({ ...u, shade: clamp(u.shade + 0.1, -1, 1) }));
    word.width = wordWidth(word.falseStart) + baseSpaceWidth * 0.55 + word.width;
  };

  // ------------------------------------------------------------ page slots

  const geomCache = new Map<number, PageGeometry>();
  const geomFor = (i: number): PageGeometry => {
    let g = geomCache.get(i);
    if (!g) {
      g = i === 0 ? geom0 : geometryOf(i);
      geomCache.set(i, g);
    }
    return g;
  };

  const pages: PageLayout[] = [];
  const pageAt = (i: number): PageLayout => {
    while (pages.length <= i) pages.push({ index: pages.length, glyphs: [], strokes: [], images: [] });
    return pages[i];
  };

  let pi = 0; // page
  let ai = 0; // area within the page
  let li = 0; // next free line within the area
  let globalLine = 0;
  let linesOnPage = 0;
  let truncated = 0;

  interface Slot {
    page: PageLayout;
    geom: PageGeometry;
    area: TextArea;
    /** Baseline of the rule the text sits on. */
    y: number;
    /** 0..1 position down the page, for fatigue. */
    pageProgress: number;
  }

  const takeSlot = (count: number): Slot | null => {
    for (let guard = 0; guard < MAX_PAGES * 4; guard++) {
      const geom = geomFor(pi);
      const area = geom.areas[Math.min(ai, geom.areas.length - 1)];
      if (li + count <= area.lines.length) {
        const y = area.lines[li + count - 1];
        const total = area.lines.length;
        const slot: Slot = {
          page: pageAt(pi),
          geom,
          area,
          y,
          pageProgress: total > 1 ? (li + count - 1) / (total - 1) : 0,
        };
        li += count;
        linesOnPage += count;
        return slot;
      }
      // This area is full: move to the next column, then the next page.
      li = 0;
      ai++;
      if (ai >= geom.areas.length) {
        ai = 0;
        pi++;
        linesOnPage = 0;
        if (pi >= MAX_PAGES) return null;
      }
    }
    return null;
  };

  const forcePageBreak = (): void => {
    if (li === 0 && ai === 0 && linesOnPage === 0) return;
    pi++;
    ai = 0;
    li = 0;
    linesOnPage = 0;
  };

  // ------------------------------------------------------------ writer state

  const baselineNoise = createNoise1D(hashInts(s.seed, 0xba5e));
  const slantNoise = createNoise1D(hashInts(s.seed, 0x51a7));
  const inkNoise = createNoise1D(hashInts(s.seed, 0x1c4));
  const pressureNoise = createNoise1D(hashInts(s.seed, 0x9e55));
  const driftSize = createDrift(hashInts(s.seed, 0x5123), 11);
  const driftSlant = createDrift(hashInts(s.seed, 0x51a2), 17);
  const driftGap = createDrift(hashInts(s.seed, 0x6a70), 13);
  const driftBase = createDrift(hashInts(s.seed, 0xba51), 7);
  const unruled = s.paperStyle === 'plain';

  // ------------------------------------------------------------ placement

  const placeLine = (line: Line, rtl: boolean): void => {
    const slot = takeSlot(line.slots);
    if (!slot) {
      truncated += line.items.reduce((n, it) => n + it.word.units.length, 0);
      return;
    }
    const { page, area } = slot;
    const lineSeed = hashInts(s.seed, 0x11e5, globalLine);
    const lineNoise = globalLine * 37.17;
    const rng = mulberry32(lineSeed);
    const t = globalLine;
    globalLine++;

    const docProgress = clamp(globalLine / 160, 0, 1);
    const fatigue = 1 + clamp(w.fatigue, 0, 3) * (0.55 * slot.pageProgress + 0.3 * docProgress);
    const sizeDrift = 1 + driftSize(t) * BASE.driftScale * driftAmp;
    const slantDrift = driftSlant(t) * BASE.driftSlantDeg * driftAmp;
    const gapDrift = 1 + driftGap(t) * BASE.driftSpacing * driftAmp;
    const baseDrift = unruled ? driftBase(t) * BASE.driftBaseline * spacing * driftAmp : 0;

    const slope = clamp(gaussian(rng), -2, 2) * amp.slope;
    const tanSlope = Math.tan(slope);
    const baseY = slot.y - BASELINE_LIFT * spacing + baseDrift + gaussian(rng) * amp.baseline * 0.5;

    const avail = area.right - area.left - line.indent;
    let startX = area.left + line.indent;
    if (line.center) {
      let total = 0;
      for (const item of line.items) total += item.gap * gapDrift * line.squeeze + item.word.width;
      startX = area.left + Math.max(line.indent, (area.right - area.left - total) / 2);
    }
    const squeeze = line.squeeze;
    /** Letters crowd together as the writer runs out of room at the margin. */
    const crowd = (rel: number): number =>
      1 - 0.07 * clamp(s.lineFill, 0, 1) * smoothstep((rel / Math.max(avail, 1) - 0.82) / 0.18);
    /** Letters give up only part of what the line as a whole gives up. */
    const LETTER_SHARE = 0.35;
    const tighten = (rel: number): number => 1 - (1 - squeeze * crowd(rel)) * LETTER_SHARE;

    let x = startX;
    /** Spans of x to underline once the line is placed. */
    const underlines: { from: number; to: number }[] = [];
    let run: { from: number; to: number } | null = null;

    const drawUnits = (
      units: Unit[],
      word: Word,
      opts: { above?: boolean; struck?: boolean; scale?: number },
    ): { from: number; to: number } => {
      const above = opts.above === true;
      const extra = opts.scale ?? 1;
      const from = x;
      for (const u of units) {
        const rel = x - startX;
        const wave = baselineNoise(rel / (spacing * 2.5) + lineNoise) * amp.wave;
        let y = baseY + rel * tanSlope + wave + u.nBaseline * amp.baseline * fatigue + u.pBaseline + word.baseline;
        if (above) y -= spacing * 0.62;
        const slantDeg =
          s.slant +
          slantDrift +
          slantNoise(rel / (spacing * 4) + lineNoise) * amp.slantDrift +
          u.nSlant * amp.slantRandom * fatigue +
          word.slant +
          (u.em & EM_ITALIC ? 9 : 0);
        const flow = (rel + lineNoise * 40) / (fontPx * 5);
        const bold = (u.em & EM_BOLD) !== 0;
        const sc = sizeDrift * extra;
        const glyph: PlacedGlyph = {
          text: u.text,
          x: rtl ? area.left + area.right - x - u.width * extra : x,
          y,
          rotation: slope + u.nRotation * amp.rotation * fatigue + u.pRotation,
          skew: Math.tan(clamp(slantDeg, -45, 45) * DEG) + u.pSkew,
          scaleX: u.scaleX * sc,
          scaleY: u.scaleY * sc,
          opacity: clamp(1 - amp.ink * (0.5 + 0.5 * inkNoise(flow)), 0.15, 1),
          pressure: clamp(0.5 + 0.5 * pressureNoise(flow * 0.7 + 11) + (bold ? 0.35 : 0), 0, 1),
          shade: clamp(u.shade + (bold ? 0.25 : 0), -1, 1),
        };
        if (rtl) glyph.rtl = true;
        page.glyphs.push(glyph);
        x += u.advance * extra * tighten(rel);
      }
      const span = { from, to: x };
      if (opts.struck) page.strokes.push(strikeStroke(span, baseY, line.fontPx, rng));
      return span;
    };

    if (line.bullet) {
      // A hand-made bullet: a short, heavy dab of the pen.
      page.strokes.push({
        points: [{ x: startX - line.fontPx * 0.45, y: baseY - line.fontPx * 0.18 }],
        width: line.fontPx * 0.15,
        opacity: 0.95,
        shade: 0.2,
        taper: true,
      });
    }

    for (const item of line.items) {
      const word = item.word;
      x += item.gap * gapDrift * squeeze;
      if (word.inserted) {
        // The writer noticed the missing word and squeezed it in above a caret.
        const caretX = x;
        const span = drawUnits(word.units, word, { above: true, scale: 0.78 });
        page.strokes.push(caretStroke((caretX + span.to) / 2, baseY, line.fontPx));
        x = caretX + line.fontPx * 0.35;
        continue;
      }
      if (word.falseStart.length > 0) {
        drawUnits(word.falseStart, word, { struck: true });
        x += baseSpaceWidth * 0.55 * squeeze;
      }
      const span = drawUnits(word.units, word, {});
      const firstGlyph = page.glyphs[page.glyphs.length - word.units.length];
      if (firstGlyph && word.blot > 0.6) firstGlyph.blot = (word.blot - 0.6) / 0.4;

      const underlined = line.underline || (word.em & EM_UNDERLINE) !== 0;
      if (underlined) {
        if (run && span.from - run.to < baseSpaceWidth * 2) run.to = span.to;
        else {
          if (run) underlines.push(run);
          run = { from: span.from, to: span.to };
        }
      } else if (run) {
        underlines.push(run);
        run = null;
      }
    }
    if (run) underlines.push(run);

    for (const span of underlines) {
      if (span.to - span.from < line.fontPx * 0.2) continue;
      const from = rtl ? area.left + area.right - span.to : span.from;
      const to = rtl ? area.left + area.right - span.from : span.to;
      page.strokes.push(underlineStroke(from, to, baseY + line.fontPx * 0.17, line.fontPx, rng, slope));
    }
  };

  // ------------------------------------------------------------ diagrams

  const imageSize = options.imageSize ?? (() => null);

  /**
   * A diagram takes whole lines: the writer leaves a gap of the right shape,
   * draws in it, and carries on underneath. It is never split over two pages,
   * because `takeSlot` moves on when the run of lines does not fit.
   */
  const placeImage = (block: Block, bi: number): void => {
    const geomNow = geomFor(pi);
    const areaNow = geomNow.areas[Math.min(ai, geomNow.areas.length - 1)];
    const column = areaNow.right - areaNow.left;
    const natural = imageSize(block.src);
    const aspect = natural && natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 0.7;

    // An equation asks to be drawn at a particular size — the size of the
    // writing around it — because that is what copying one out means. A
    // figure just takes its share of the column.
    let width = natural?.widthUnits ? Math.min(column, natural.widthUnits) : column * clamp(s.diagramScale, 0.15, 1);
    let height = width * aspect;
    // Never taller than most of a column, or it could never be placed at all.
    const maxHeight = Math.max(1, Math.floor(areaNow.lines.length * 0.85)) * spacing - spacing * 0.4;
    if (height > maxHeight) {
      height = maxHeight;
      width = height / aspect;
    }
    const slots = Math.max(1, Math.ceil((height + spacing * 0.45) / spacing));

    const slot = takeSlot(slots);
    if (!slot) {
      truncated += 1;
      return;
    }
    globalLine += slots;

    const rng = mulberry32(hashInts(s.seed, 0x1a3e, bi));
    const bandTop = slot.y - (slots - 1) * spacing - spacing * 0.78;
    const free = slots * spacing - spacing * 0.3 - height;
    const x = slot.area.left + (slot.area.right - slot.area.left - width) / 2 + gaussian(rng) * spacing * 0.07;
    const y = bandTop + Math.max(0, free) / 2;
    slot.page.images.push({
      id: block.src,
      x,
      y,
      width,
      height,
      rotation: gaussian(rng) * 0.9 * DEG * clamp(w.rotation, 0, 2) * clamp(s.messiness * 2, 0, 2),
    });
    if (s.diagramFrame || natural === null) slot.page.strokes.push(...frameStrokes(x, y, width, height, fontPx, rng));
  };

  // ------------------------------------------------------------ blocks

  const blocks = parseBlocks(text, s.markdown);
  const paragraphIndent = Math.max(0, s.paragraphIndent) * (96 / 25.4);
  const corrections = clamp(s.corrections, 0, 1);

  blocks.forEach((block, bi) => {
    if (block.kind === 'pagebreak') {
      forcePageBreak();
      return;
    }
    if (block.kind === 'blank') {
      takeSlot(1);
      globalLine++;
      return;
    }
    if (block.kind === 'image') {
      if (s.diagrams) placeImage(block, bi);
      return;
    }
    if (block.kind === 'divider') {
      const slot = takeSlot(1);
      if (slot) {
        const rng = mulberry32(hashInts(s.seed, 0xd1d, bi));
        const mid = slot.y - spacing * 0.35;
        const from = slot.area.left + (slot.area.right - slot.area.left) * 0.06;
        const to = slot.area.right - (slot.area.right - slot.area.left) * 0.06;
        slot.page.strokes.push(underlineStroke(from, to, mid, fontPx, rng, 0));
      }
      globalLine++;
      return;
    }

    const heading = block.kind === 'heading' ? HEADING_STYLE[block.level] ?? HEADING_STYLE[3] : null;
    // A caption is written smaller and centred under the figure it belongs to.
    const caption = block.kind === 'caption';
    if (caption && !s.diagrams) return;
    const sizeRatio = heading ? heading.scale : caption ? 0.88 : 1;
    const lineFontPx = fontPx * sizeRatio;
    const slots = sizeRatio >= 1.35 ? 2 : 1;
    const emAt = block.emphasis ? (o: number) => (o < block.emphasis!.length ? block.emphasis![o] : 0) : () => 0;

    // A heading gets air above it, the way a writer pauses before one.
    if (heading && li > 0) {
      takeSlot(1);
      globalLine++;
    }

    const rtl = isRtlParagraph(block.text);
    const tokens = tokenize(block.text, rtl);
    if (tokens.length === 0) {
      takeSlot(1);
      globalLine++;
      return;
    }

    const words: Word[] = [];
    tokens.forEach((token, wi) => {
      const rng = mulberry32(hashInts(s.seed, bi, wi));
      const word = buildWord(token, rng, emAt, sizeRatio);
      // Human corrections: a crossed-out restart, or a word squeezed in above.
      if (corrections > 0 && wi > 0 && word.units.length > 2) {
        const roll = mulberry32(hashInts(s.seed, bi, wi, 0xc07));
        const p = corrections * 0.012;
        const r = roll();
        if (r < p * 0.65) addFalseStart(word, roll);
        else if (r < p) {
          word.inserted = true;
          word.width = lineFontPx * 0.35;
        }
      }
      words.push(word);
    });

    // Numbered list markers are written; bullets are drawn as a dab of ink.
    const bullet = block.kind === 'list' && block.marker === '•';
    if (block.kind === 'list' && block.marker && !bullet) {
      const markerToken: Token = { units: [...block.marker], spacesBefore: 0, shaped: false, offset: -1 };
      const marker = buildWord(markerToken, mulberry32(hashInts(s.seed, bi, 0x3a5)), () => 0, sizeRatio);
      marker.gap = 0;
      words.unshift(marker);
      if (words.length > 1) words[1].gap = Math.max(words[1].gap, baseSpaceWidth * 0.8);
    }

    // Indents: source whitespace, paragraph indent, list hang, quote inset.
    const spaceIndent = block.indentSpaces * baseSpaceWidth * 0.55;
    let firstIndent = spaceIndent;
    let hangIndent = spaceIndent;
    if (block.kind === 'paragraph' && paragraphIndent > 0) firstIndent += paragraphIndent;
    if (block.kind === 'list') {
      const hang = bullet ? lineFontPx * 0.75 : lineFontPx * 1.1;
      firstIndent += hang;
      hangIndent += hang;
    }
    if (block.kind === 'quote') {
      firstIndent += lineFontPx * 1.2;
      hangIndent += lineFontPx * 1.2;
    }

    const areaWidth = () => {
      const geom = geomFor(pi);
      const area = geom.areas[Math.min(ai, geom.areas.length - 1)];
      return area.right - area.left;
    };

    // ------------------------------------------------ break into lines
    const fill = clamp(s.lineFill, 0, 1);
    const maxIndent = amp.indent * 3;
    let lineIndex = 0;
    let items: LineItem[] = [];
    let x = 0;
    let ragged = 0;
    let indentFor = firstIndent;
    let full = areaWidth();

    const flush = (squeeze = 1): void => {
      if (items.length === 0) return;
      placeLine(
        {
          items,
          indent: indentFor + ragged,
          squeeze,
          slots,
          underline: heading?.underline ?? false,
          bullet: bullet && lineIndex === 0,
          center: caption,
          fontPx: lineFontPx,
        },
        rtl,
      );
      items = [];
      x = 0;
      lineIndex++;
      indentFor = hangIndent;
      ragged = raggedIndent(lineIndex);
      full = areaWidth();
    };

    const raggedIndent = (index: number): number => {
      const r = mulberry32(hashInts(s.seed, 0x1a6, bi, index));
      return Math.min(maxIndent, Math.abs(gaussian(r)) * amp.indent);
    };
    ragged = raggedIndent(0);

    const queue: Word[] = [];
    for (let i = words.length - 1; i >= 0; i--) queue.push(words[i]);

    while (queue.length > 0) {
      const word = queue.pop()!;
      const avail = full - indentFor - ragged;
      if (items.length === 0) {
        if (word.width > avail && word.units.length > 1) {
          // A word longer than the line: break it wherever it has to give.
          const parts = splitWord(word, Math.max(lineFontPx, avail));
          for (let i = parts.length - 1; i >= 0; i--) queue.push(parts[i]);
          continue;
        }
        const lead = lineIndex === 0 && word.spacesBefore > 0 ? Math.min(word.gap, avail * 0.3) : 0;
        items.push({ word, gap: lead });
        x = lead + word.width;
        continue;
      }

      const gap = word.gap * gapAfterFactor(items[items.length - 1].word.units.map((u) => u.text).join('')) * gapBeforeFactor(word.units[0]?.text ?? '');
      const needed = x + gap + word.width;
      if (needed <= avail) {
        items.push({ word, gap });
        x = needed;
        continue;
      }

      // The line is full. A writer does one of four things.
      const over = needed - avail;
      const shortfall = avail - x; // room that would be left blank
      const overrun = avail * 0.035 * fill + lineFontPx * 0.15 * fill;
      if (over <= overrun) {
        // 1. Run a little past the margin rather than leave a hole.
        items.push({ word, gap });
        x = needed;
        flush();
        continue;
      }
      const hyphenTarget = word.units.length > 5 ? unitsThatFit(word, avail - x - gap - lineFontPx * 0.3) : 0;
      if (fill > 0.25 && shortfall > baseSpaceWidth * 3 && hyphenTarget >= 3) {
        // 2. Break the word with a hyphen.
        const at = hyphenPoint(
          word.units.map((u) => u.text),
          hyphenTarget,
        );
        if (at >= 3) {
          const dashWidth = width('-');
          const [head, tail] = hyphenate(word, at, mulberry32(hashInts(s.seed, bi, 0xf00 + lineIndex)), dashWidth);
          items.push({ word: head, gap });
          flush();
          queue.push(tail);
          continue;
        }
      }
      if (over <= needed * 0.06 * fill) {
        // 3. Cram the whole line together to make the last word fit.
        items.push({ word, gap });
        flush(avail / needed);
        continue;
      }
      // 4. Give up on the line and carry the word over.
      flush();
      queue.push(word);
    }
    flush();
  });

  // ------------------------------------------------------------ page numbers

  while (
    pages.length > 1 &&
    pages[pages.length - 1].glyphs.length === 0 &&
    pages[pages.length - 1].strokes.length === 0 &&
    pages[pages.length - 1].images.length === 0
  ) {
    pages.pop();
  }
  if (pages.length === 0) pages.push({ index: 0, glyphs: [], strokes: [], images: [] });

  if (s.features.pageNumber === 'handwritten') {
    pages.forEach((page, i) => {
      const geom = geomFor(i);
      const spot = geom.pageNumberAt;
      if (!spot) return;
      const label = String(i + 1);
      const rng = mulberry32(hashInts(s.seed, 0x9a6e, i));
      const sc = 0.92;
      const total = width(label) * sc;
      let x = spot.align === 'right' ? spot.x - total : spot.align === 'center' ? spot.x - total / 2 : spot.x;
      for (const ch of label) {
        page.glyphs.push({
          text: ch,
          x,
          y: spot.y + gaussian(rng) * spacing * 0.02,
          rotation: gaussian(rng) * 1.5 * DEG,
          skew: Math.tan(clamp(s.slant + gaussian(rng) * 2, -45, 45) * DEG),
          scaleX: sc,
          scaleY: sc,
          opacity: 1,
          pressure: 0.6,
          shade: 0.1,
        });
        x += width(ch) * sc;
      }
    });
  }

  // A stray dot of ink, the way a pen parked on the page leaves one.
  if (corrections > 0) {
    pages.forEach((page, i) => {
      const rng = mulberry32(hashInts(s.seed, 0xb107, i));
      if (rng() > corrections * 0.35) return;
      const geom = geomFor(i);
      const area = geom.areas[0];
      page.strokes.push({
        points: [
          {
            x: area.left + (area.right - area.left) * rng(),
            y: area.lines[Math.floor(rng() * area.lines.length)] - spacing * (0.1 + rng() * 0.3),
          },
        ],
        width: fontPx * (0.05 + rng() * 0.07),
        opacity: 0.8,
        shade: 0.3,
        taper: true,
      });
    });
  }

  return { geometry: geom0, geometryOf: geomFor, fontPx, pages, truncated };
}

// ---------------------------------------------------------------- helpers

function emScale(em: number): number {
  return em & EM_BOLD ? 1.035 : 1;
}

function wordWidth(units: Unit[]): number {
  let total = 0;
  for (let i = 0; i < units.length; i++) total += i === units.length - 1 ? units[i].width : units[i].advance;
  return total;
}

/** How many units of a word fit in `room`. */
function unitsThatFit(word: Word, room: number): number {
  let used = 0;
  for (let i = 0; i < word.units.length; i++) {
    const u = word.units[i];
    if (used + u.width > room) return i;
    used += u.advance;
  }
  return word.units.length;
}

function cloneWord(word: Word, units: Unit[], first: boolean): Word {
  return {
    ...word,
    units,
    width: wordWidth(units),
    gap: first ? word.gap : 0,
    spacesBefore: first ? word.spacesBefore : 0,
    falseStart: first ? word.falseStart : [],
  };
}

/** Split a word at `at`, writing a hyphen at the end of the first half. */
function hyphenate(word: Word, at: number, rng: Rng, dashWidth: number): [Word, Word] {
  const head = word.units.slice(0, at);
  const tail = word.units.slice(at);
  const model = head[head.length - 1];
  const drawn = dashWidth * model.scaleX;
  const dash: Unit = {
    ...model,
    text: '-',
    // The dash is written at the scale of the letter it follows.
    width: drawn,
    advance: drawn,
    nBaseline: gaussian(rng) * 0.6,
    nRotation: gaussian(rng) * 0.6,
    em: 0,
  };
  return [cloneWord(word, [...head, dash], true), cloneWord(word, tail, false)];
}

/** Break a word that is wider than a line into line-sized chunks. */
function splitWord(word: Word, limit: number): Word[] {
  const chunks: Word[] = [];
  let current: Unit[] = [];
  let advances = 0; // sum of advances of `current`
  for (const unit of word.units) {
    if (current.length > 0 && advances + unit.width > limit) {
      chunks.push(cloneWord(word, current, chunks.length === 0));
      current = [];
      advances = 0;
    }
    current.push(unit);
    advances += unit.advance;
  }
  if (current.length > 0) chunks.push(cloneWord(word, current, chunks.length === 0));
  return chunks;
}

/** A hand-drawn line: slightly bowed, slightly uneven, never straight. */
function handLine(x0: number, y0: number, x1: number, y1: number, rng: Rng, bow: number): InkStroke['points'] {
  const steps = Math.max(3, Math.min(14, Math.round(Math.abs(x1 - x0) / 12)));
  const points: InkStroke['points'] = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const wobble = (rng() - 0.5) * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const arc = Math.sin(t * Math.PI) * bow;
    points.push({
      x: x0 + dx * t + (rng() - 0.5) * 0.6,
      y: y0 + dy * t + arc + Math.sin(t * 7 + wobble) * bow * 0.25 + (rng() - 0.5) * 0.5,
    });
  }
  return points;
}

function underlineStroke(from: number, to: number, y: number, fontPx: number, rng: Rng, slope: number): InkStroke {
  const drop = (to - from) * Math.tan(slope);
  const bow = fontPx * (0.02 + rng() * 0.05);
  return {
    points: handLine(from - fontPx * 0.04, y, to + fontPx * 0.06, y + drop, rng, bow),
    width: fontPx * 0.045,
    opacity: 0.92,
    shade: 0.1,
    taper: true,
  };
}

function strikeStroke(span: { from: number; to: number }, baseY: number, fontPx: number, rng: Rng): InkStroke {
  const y = baseY - fontPx * 0.18;
  return {
    points: handLine(span.from - fontPx * 0.08, y + fontPx * 0.05, span.to + fontPx * 0.08, y - fontPx * 0.04, rng, fontPx * 0.03),
    width: fontPx * 0.05,
    opacity: 0.95,
    shade: 0.15,
    taper: false,
  };
}

/**
 * A box ruled round a figure by hand: four strokes, each overshooting the
 * corner a little, because nobody stops exactly on it.
 */
function frameStrokes(x: number, y: number, w: number, h: number, fontPx: number, rng: Rng): InkStroke[] {
  const over = fontPx * 0.07;
  const bow = fontPx * 0.015;
  const width = fontPx * 0.035;
  const edge = (x0: number, y0: number, x1: number, y1: number): InkStroke => ({
    points: handLine(x0, y0, x1, y1, rng, bow),
    width,
    opacity: 0.85,
    shade: 0.05,
    taper: true,
  });
  return [
    edge(x - over, y, x + w + over, y),
    edge(x + w, y - over, x + w, y + h + over),
    edge(x + w + over, y + h, x - over, y + h),
    edge(x, y + h + over, x, y - over),
  ];
}

/** The caret that marks where a squeezed-in word belongs. */
function caretStroke(x: number, baseY: number, fontPx: number): InkStroke {
  const h = fontPx * 0.18;
  return {
    points: [
      { x: x - h * 0.8, y: baseY + h * 0.1 },
      { x, y: baseY - h },
      { x: x + h * 0.8, y: baseY + h * 0.1 },
    ],
    width: fontPx * 0.04,
    opacity: 0.9,
    shade: 0.1,
    taper: true,
  };
}
