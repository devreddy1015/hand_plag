/**
 * Shared types for the rendering engine.
 *
 * Layout units: all positions are CSS pixels at 96 DPI ("u"). A page is
 * rendered at any resolution by scaling, so preview and export share one
 * layout.
 */

export type PaperStyle = 'plain' | 'ruled' | 'grid' | 'dotted' | 'four-line' | 'seyes';
export type PenType = 'ballpoint' | 'gel' | 'rollerball' | 'fountain' | 'calligraphy' | 'felt' | 'pencil';

/** Vertical printed line(s) down the left of the writing area. */
export type MarginRule = 'none' | 'single' | 'double' | 'box';
/** Binding marks punched or drilled into the sheet. */
export type Holes = 'none' | 'punch2' | 'punch3' | 'spiral';
export type PageNumberMode = 'none' | 'printed' | 'handwritten';
/** How the finished page is presented: flat art, a flatbed scan, or a phone photo. */
export type FinishLook = 'none' | 'scan' | 'photo';

/** Margins in millimetres. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Printed furniture on the sheet. A paper template is a preset of these. */
export interface PaperFeatures {
  marginRule: MarginRule;
  /** Horizontal rule across the top margin, as in a school notebook. */
  headerRule: boolean;
  /** Printed "Name / Class / Date" line in the header. */
  nameDateLine: boolean;
  holes: Holes;
  /** Binding (and the wider margin) swaps sides on even pages, like a bound book. */
  mirrorEvenPages: boolean;
  pageNumber: PageNumberMode;
  /** Width in mm of a left-hand cue column (Cornell notes). 0 = none. */
  cueColumn: number;
  /** Height in mm of a summary area cut off the bottom (Cornell notes). 0 = none. */
  summaryBox: number;
  /** Text columns per page. */
  columns: 1 | 2;
  /** Gutter between columns, in mm. */
  columnGap: number;
  /** Draw a line down the gutter. */
  columnDivider: boolean;
  /** Faint ink showing through from the other side of the sheet. */
  showThrough: boolean;
  /** Torn-out-of-a-notebook left edge. */
  tornEdge: boolean;
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
  /** Slow drift of size, slant and spacing over many lines. */
  drift: number;
  /** Words sitting off the line as a whole, rather than letter by letter. */
  word: number;
}

export interface Settings {
  text: string;
  /** Read `#` headings, `-` lists and `**emphasis**` as structure. */
  markdown: boolean;
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
  /** 0 = leave lines short, 1 = squeeze and overrun to fill every line. */
  lineFill: number;
  /** First-line indent of each paragraph, in mm. */
  paragraphIndent: number;
  inkColor: string;
  pen: PenType;
  /** Stroke weight multiplier on top of the pen's own weight. */
  inkWeight: number;

  paperSize: string;
  landscape: boolean;
  paperStyle: PaperStyle;
  /** Paper template id. Selecting one writes a group of the fields below. */
  template: string;
  /** Distance between ruled lines in millimetres. */
  lineSpacing: number;
  paperColor: string;
  ruleColor: string;
  /** Colour of the vertical margin rule. */
  marginColor: string;
  margins: Margins;
  features: PaperFeatures;
  texture: boolean;
  finish: FinishLook;

  /** 0 = tidy, 1 = very messy. 0.5 is a natural default. */
  messiness: number;
  /** Rate of human corrections: crossed-out restarts and words squeezed in above the line. */
  corrections: number;
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
  /** Ink pooled where the pen was set down. */
  blot?: number;
}

/** A pen stroke that is not a letter: underline, strike-out, bullet, caret, divider. */
export interface InkStroke {
  /** Polyline through which the pen travelled, in layout units. */
  points: { x: number; y: number }[];
  /** Nib width in layout units. */
  width: number;
  opacity: number;
  /** -1..1 shade drift, as for glyphs. */
  shade: number;
  /** Round off the ends (a pen lift leaves a blunt end when false). */
  taper?: boolean;
}

export interface PageLayout {
  index: number;
  glyphs: PlacedGlyph[];
  strokes: InkStroke[];
}

/** One rectangle of writable lines. Pages with two columns have two. */
export interface TextArea {
  left: number;
  right: number;
  /** Baseline y of each writable line, top to bottom. */
  lines: number[];
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
  /** y of every horizontal rule printed on the page. */
  rules: number[];
  /** y of dashed midlines (four-line and Seyes ruling). */
  midRules: number[];
  /** x of every vertical rule printed down the page. */
  verticalRules: number[];
  /** Writable areas, in the order text fills them. */
  areas: TextArea[];
  /** x of the vertical margin rule(s). */
  marginLines: number[];
  /** y of the header rule, when the template has one. */
  headerRuleY: number | null;
  /** y of the Cornell summary rule. */
  summaryY: number | null;
  /** Punched or drilled binding holes. */
  holes: { x: number; y: number; r: number }[];
  /** Printed frame around the writing area. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Which edge the binding is on for this page. */
  bindingSide: 'left' | 'right';
  /** Baseline and x of the page number, when it is written or printed. */
  pageNumberAt: { x: number; y: number; align: 'left' | 'center' | 'right' } | null;
}

export interface DocumentLayout {
  /** Geometry of page 0. Later pages can mirror it; use `geometryOf`. */
  geometry: PageGeometry;
  /** Geometry of a given page (mirrored on even pages when enabled). */
  geometryOf: (pageIndex: number) => PageGeometry;
  /** Font size in layout units. */
  fontPx: number;
  pages: PageLayout[];
  /** Layout ran out of room and dropped this many drawn units (0 normally). */
  truncated: number;
}

/** Returns the advance width of a string in layout units at the layout font size. */
export type Measurer = (text: string) => number;
