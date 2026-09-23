/**
 * Shared types for the rendering engine.
 *
 * Layout units: all positions are CSS pixels at 96 DPI ("u"). A page is
 * rendered at any resolution by scaling, so preview and export share one
 * layout.
 */

export type PaperStyle = 'plain' | 'ruled' | 'grid' | 'dotted';
export type PenType = 'ballpoint' | 'gel' | 'fountain' | 'pencil';

/** Margins in millimetres. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Relative strength of each realism effect. 1 is the default, 0 turns it off. */
export interface JitterWeights {
  /** Letters bobbing above and below the line. */
  baseline: number;
  /** Per-letter rotation. */
  rotation: number;
  /** Per-letter size changes. */
  scale: number;
  /** Uneven gaps between letters and words. */
  spacing: number;
  /** Lines that tilt slightly up or down. */
  lineSlope: number;
  /** Ragged left edge. */
  indent: number;
  /** Writing gets messier further down the page. */
  fatigue: number;
  /** Ink flow and pressure variation. */
  ink: number;
}

export interface Settings {
  text: string;
  /** Font catalog id, or a custom font id created on upload. */
  fontId: string;
  /** x-height as a fraction of the line spacing. */
  letterSize: number;
  /** Writer's slant in degrees. Positive leans right. */
  slant: number;
  /** Extra space between letters, as a fraction of the font size. */
  letterSpacing: number;
  /** Multiplier on the font's own space width. */
  wordSpacing: number;
  inkColor: string;
  pen: PenType;

  paperSize: string;
  landscape: boolean;
  paperStyle: PaperStyle;
  /** Distance between ruled lines in millimetres. */
  lineSpacing: number;
  paperColor: string;
  ruleColor: string;
  marginLine: boolean;
  margins: Margins;
  texture: boolean;
  scanEffect: boolean;

  /** 0 = tidy, 1 = very messy. 0.5 is a natural default. */
  messiness: number;
  jitter: JitterWeights;
  seed: number;
}

export interface PaperSize {
  id: string;
  label: string;
  /** Portrait width and height in millimetres. */
  width: number;
  height: number;
}

/** One drawn unit: a grapheme cluster, or a whole word for scripts that need shaping. */
export interface PlacedGlyph {
  text: string;
  /** Baseline origin in layout units. */
  x: number;
  y: number;
  /** Radians, clockwise. */
  rotation: number;
  /** Horizontal shear, tan(slant). Positive leans right. */
  skew: number;
  scaleX: number;
  scaleY: number;
  /** 0..1 */
  opacity: number;
  /** 0..1, extra stroke weight from pen pressure. */
  pressure: number;
  /** -1..1, drift of the ink colour lighter or darker. */
  shade: number;
  /** Shape with a right-to-left base direction (set only in RTL paragraphs). */
  rtl?: true;
}

export interface PageLayout {
  index: number;
  glyphs: PlacedGlyph[];
}

export interface PageGeometry {
  /** Page size in layout units. */
  width: number;
  height: number;
  /** Physical size, used for PDF page boxes. */
  widthMm: number;
  heightMm: number;
  /** Line spacing in layout units. */
  spacing: number;
  /** y of every ruled line printed on the page (header line first). */
  rules: number[];
  /** y of the rules that carry text. */
  textLines: number[];
  textLeft: number;
  textRight: number;
  /** x of the vertical margin line. */
  marginLineX: number;
}

export interface DocumentLayout {
  geometry: PageGeometry;
  /** Font size in layout units. */
  fontPx: number;
  pages: PageLayout[];
}

/** Returns the advance width of a string in layout units at the layout font size. */
export type Measurer = (text: string) => number;
