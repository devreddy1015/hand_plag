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
/** How the finished page is presented: flat, a flatbed scan, a phone-app scan, or a photo on a desk. */
export type FinishLook = 'none' | 'scan' | 'phone' | 'photo';

/**
 * What a writer does with a diagram from the source document: copy it out in
 * pen, as a student copies a figure off the board, or stick the printed thing
 * onto the page.
 */
export type DiagramStyle = 'sketch' | 'pasted';

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
  /** The sheet is written on both sides: the other side shows faintly through, mirrored. */
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
  /** Every copy of a letter bent into a slightly different shape. */
  shape: number;
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
  /** Grain in the paper, and the groove the pen presses into it. */
  texture: boolean;
  finish: FinishLook;

  /** Keep diagrams from the source, and how to put them on the page. */
  diagrams: boolean;
  diagramStyle: DiagramStyle;
  /** Rule a box around each diagram, by hand. */
  diagramFrame: boolean;
  /** Width of a diagram as a fraction of the writing column. */
  diagramScale: number;

  /** The writer's name, written by hand at the top of the sheet. Empty leaves it off. */
  writerName: string;
  /** The writer's ID or roll number, written beside the name. Empty leaves it off. */
  writerId: string;
  /** Write the name and ID at the top of every sheet, not only the first. On by default. */
  writerEveryPage: boolean;

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
  /** Which of the writer's habitual forms of this letter. */
  variant?: number;
  /** Seed for the bend of this one copy of the letter. */
  seed?: number;
  /** How far the letter's shape is bent away from the font's (0 = not at all). */
  warp?: number;
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
  /** Ink the inside of the closed outline too (a filled arrowhead, a dot on a graph). */
  fill?: boolean;
}

/**
 * A diagram as a writer copies it: the lines to draw, the areas to shade,
 * and the words to write. Everything is measured in widths of the figure,
 * so x runs 0..1 and y runs 0..1/aspect, and nothing depends on the size of
 * the picture it was traced from.
 */
export interface Sketch {
  /** Width over height. */
  aspect: number;
  /** Pen paths, as x, y pairs. */
  paths: { pts: number[]; weight: number; closed?: boolean }[];
  /**
   * Filled areas, as outlines. Small ones are inked in; large ones are shaded,
   * closer for darker fills, and each colour group in its own way.
   */
  fills: { pts: number[]; area: number; tone?: number; group?: number }[];
  /** Words in the figure, written in the hand where they stood. */
  labels: SketchLabel[];
  /** Typical line width in the source, in figure widths, so heavy lines stay heavier. */
  lineWidth: number;
  /** Drawn by hand on the pad already: its lines are the writer's own and are not shaken again. */
  handmade?: boolean;
  /**
   * A sentence copied out whole, for the maths in it: written from the margin
   * on the ruled line, not centred like a displayed equation.
   */
  prose?: boolean;
}

export interface SketchLabel {
  text: string;
  /** Left end and baseline of the printed words. */
  x: number;
  y: number;
  /** Width of the printed words. */
  w: number;
  /** Size of the printed type. */
  size: number;
}

/** A diagram placed on the page: copied out in pen, or stuck on. */
export interface PlacedImage {
  /** Key into the image registry handed to the renderer. */
  id: string;
  /** Top-left corner in layout units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Radians. Nothing is ever drawn or stuck on perfectly square. */
  rotation: number;
  /** A photograph is always stuck on: nobody copies one out in pen. */
  photo?: boolean;
}

export interface PageLayout {
  index: number;
  glyphs: PlacedGlyph[];
  strokes: InkStroke[];
  images: PlacedImage[];
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
