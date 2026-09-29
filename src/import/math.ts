/**
 * Finding the equations on a page.
 *
 * Mathematics does not survive being read back as text. A displayed formula
 * is set as a two-dimensional arrangement of glyph runs — numerator above
 * rule above denominator, limits above and below a summation sign — so
 * reading it line by line gives three lines of nonsense where there was one
 * equation:
 *
 *        2.303RT
 *   ∆p = ∆ψ −            ∆pH,        (1)
 *           F
 *
 * The honest thing is to stop pretending it is text. A displayed equation is
 * found here, cut out of the rendered page like any other figure, and written
 * onto the sheet as a drawing — which is what a person does with an equation
 * anyway: they copy it out.
 *
 * Nothing here touches a canvas or a PDF; it works on the lines already
 * recovered, so it can be tested on its own.
 */
import type { Box } from './figures';
import type { Line } from './reflow';

/**
 * Fonts that only ever hold mathematics. `CMMI`, `CMSY` and `CMEX` are TeX's
 * math italic, symbol and extension fonts; the rest cover the other common
 * ways of setting maths, including Word's.
 */
const MATH_FONT = /CM(MI|SY|EX)|MSAM|MSBM|EUFM|EURM|RSFS|STIX|XITS|Asana|Latin\s*Modern\s*Math|LMMath|TeX.?Math|MathJax|Cambria\s*Math|Math.*Italic/i;

/**
 * Fonts that draw rather than write: LaTeX's picture-mode line and circle
 * fonts (every arrowhead in a LaTeX diagram is a character in one of them),
 * the big delimiters of CMEX, and the AMS symbol fonts' arrows.
 */
const DRAWING_FONT = /^(LINE|LINEW|LCIRCLE|LCIRCLEW)\d*$|CMEX|Wingdings|ZapfDingbats|Webdings/i;

/** Is this font used to draw pieces of pictures rather than to set words? */
export function isDrawingFont(name: string | undefined | null): boolean {
  if (!name) return false;
  return DRAWING_FONT.test(name.replace(/^[A-Z]{6}\+/, ''));
}

/** Is this font used only for setting mathematics? */
export function isMathFont(name: string | undefined | null): boolean {
  if (!name) return false;
  // Embedded fonts carry a random six-letter tag: ABCDEF+CMMI10.
  return MATH_FONT.test(name.replace(/^[A-Z]{6}\+/, ''));
}

/** Bold faces: TeX's bold extended fonts by their names, everything else by its style. */
const BOLD_FONT = /bold|black|heavy|semibold|demibold|^CMBX|^CMB\d|^CMMIB|^CMBSY|^EUFB|^EUSB|^EURB/i;

/** Is this font a bold face? */
export function isBoldFont(name: string | undefined | null): boolean {
  if (!name) return false;
  return BOLD_FONT.test(name.replace(/^[A-Z]{6}\+/, ''));
}

export interface MathLimits {
  /** Left and right edge of the running text. */
  bodyLeft: number;
  bodyRight: number;
  /** Usual distance between two lines of running text. */
  leading: number;
  /** Usual size of the running text. */
  bodySize: number;
}

export interface MathResult {
  /** One box per displayed equation, to be cut out of the page. */
  boxes: Box[];
  /** Lines that are part of an equation and must not be written as prose. */
  consumed: Set<Line>;
}

/**
 * Displayed equations, as boxes to cut out.
 *
 * A displayed equation is set in maths fonts, indented from the margin
 * (centred, in practice), and stacked tightly — the pieces of one formula sit
 * far closer together than two lines of prose. Inline maths inside a
 * paragraph is left alone: the line around it is ordinary text, and cutting it
 * out would take the sentence with it.
 */
export function findMathBlocks(lines: Line[], limits: MathLimits): MathResult {
  const { bodyLeft, bodyRight, leading, bodySize } = limits;
  const measure = Math.max(1, bodyRight - bodyLeft);
  const consumed = new Set<Line>();
  const boxes: Box[] = [];

  /** Set apart from the margin, as displayed matter always is. */
  const indented = (line: Line) => line.x0 > bodyLeft + bodySize * 0.8;
  /** Short enough not to be a line of prose that happens to hold a symbol. */
  const narrow = (line: Line) => line.x1 - line.x0 < measure * 0.94;
  const display = (line: Line) => (line.math >= 0.25 && indented(line) && narrow(line)) || line.broken === true;
  /** A scrap of a fraction or a limit, set small, close by a broken line. */
  const scrap = (line: Line, near: Line) =>
    near.broken === true && line.text.length <= 12 && line.x1 - line.x0 < measure * 0.3 && Math.abs(line.y - near.y) < leading * 0.9;
  /**
   * A fraction's denominator, or the limits on a sum: set in, narrow, and
   * either holding maths or too short to be a sentence. The length test
   * matters because a paragraph's first line is indented too, and without it
   * every paragraph after an equation would be swallowed by it.
   */
  const fragment = (line: Line) =>
    indented(line) &&
    narrow(line) &&
    (line.math > 0 || (line.text.length <= 12 && line.x1 - line.x0 < measure * 0.3));

  // A fraction set inside a sentence puts its numerator and denominator on
  // lines of their own, just above and below the sentence's baseline: the
  // sentence has to be copied out as it stands, fraction and all.
  const tiny = (line: Line) => line.text.length <= 12 && line.x1 - line.x0 < measure * 0.3;
  for (const line of lines) {
    if (line.broken || tiny(line)) continue;
    const pieces = lines.filter(
      (other) =>
        other !== line &&
        tiny(other) &&
        Math.abs(other.y - line.y) < line.size * 0.9 &&
        other.x0 >= line.x0 - line.size &&
        other.x1 <= line.x1 + line.size,
    );
    if (pieces.length > 0) line.broken = true;
  }

  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(lines[i]) || !display(lines[i])) continue;

    const block: Line[] = [lines[i]];
    let strongest = lines[i].math;
    // Reach backwards for a numerator sitting above the first line found.
    for (let k = i - 1; k >= 0; k--) {
      const above = lines[k];
      if (consumed.has(above) || !(fragment(above) || scrap(above, block[0]))) break;
      if (block[0].y - above.y > leading * 1.35) break;
      block.unshift(above);
    }
    // Then forwards, through the rest of the formula.
    for (let k = i + 1; k < lines.length; k++) {
      const below = lines[k];
      if (consumed.has(below)) break;
      const gap = below.y - block[block.length - 1].y;
      if (gap > leading * 1.9) break;
      if (!display(below) && !fragment(below) && !scrap(below, block[block.length - 1])) break;
      block.push(below);
      strongest = Math.max(strongest, below.math);
      i = k;
    }

    // A centred heading is indented and narrow too, so insist on real maths.
    if (strongest < 0.4 && block.length < 2 && !block[0].broken) continue;

    for (const line of block) consumed.add(line);
    boxes.push(around(block, bodySize));
  }

  return { boxes, consumed };
}

/**
 * The box to cut out. Rules, roots and big brackets reach above and below the
 * glyph baselines the lines were measured from, so it is given room.
 */
function around(block: Line[], bodySize: number): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const line of block) {
    x0 = Math.min(x0, line.x0);
    x1 = Math.max(x1, line.x1);
    top = Math.min(top, line.y - line.size * 1.15);
    bottom = Math.max(bottom, line.y + line.size * 0.5);
  }
  // Kept tight: the box is grown afterwards, as far as the ink goes and no
  // further, which is more accurate than guessing at padding here.
  const padX = bodySize * 0.25;
  const padY = bodySize * 0.12;
  return { x: x0 - padX, y: top - padY, width: x1 - x0 + padX * 2, height: bottom - top + padY * 2 };
}
