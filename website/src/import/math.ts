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

/** Relations and arrows: what makes a formula a statement rather than a name. */
const RELATION = /[=<>\u2264\u2265\u2248\u2261\u2260\u221d\u2192\u2190\u2194\u21d2\u21d0\u21d4\u223c\u2243\u2245\u226a\u226b]/;

/**
 * A letter or two set in a maths font beside a drawing is the drawing's label
 * — P, z, +q, (ii) — not a formula: it is short, and nothing in it relates one
 * thing to another. It belongs to the figure it names.
 */
/** The characters actually set, without the markup for sub- and superscripts. */
function bare(text: string): string {
  return text.replace(/[_^]\{|\}|\s/g, '');
}

function isLabel(block: Line[]): boolean {
  const text = bare(block.map((line) => line.text).join(''));
  // A root sign or a trailing "+ · · ·" on its own names nothing: it is a
  // piece of a formula that has lost its way.
  if (RELATION.test(text) || !/[\p{L}\p{N}]/u.test(text)) return false;
  // Or several such labels together: the signs round a charged sphere.
  return text.length <= 8 || block.every((line) => bare(line.text).length <= 4);
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
  /** The lines each box was measured from, in the same order. */
  blocks: Line[][];
  /** Whether each box holds a sentence, copied out for the maths in it, rather than a displayed formula. */
  prose: boolean[];
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
  const blocks: Line[][] = [];
  const sentenceBlocks: boolean[] = [];

  /** Set apart from the margin, as displayed matter always is. */
  const indented = (line: Line) => line.x0 > bodyLeft + bodySize * 0.8;
  /** Short enough not to be a line of prose that happens to hold a symbol. */
  const narrow = (line: Line) => line.x1 - line.x0 < measure * 0.94;
  const display = (line: Line) => (line.math >= 0.25 && indented(line) && narrow(line)) || line.broken === true;
  /** A sentence that holds maths it cannot be read without, rather than a displayed formula. */
  const prose = (line: Line) => line.broken === true && !indented(line);
  /**
   * What is left of a sentence after a fraction set in it: the words on the
   * same baseline, starting a fraction's width or so further along.
   */
  const rest = (line: Line) => {
    const out: Line[] = [];
    let end = line.x1;
    for (const other of [...lines].sort((a, b) => a.x0 - b.x0)) {
      if (other === line || Math.abs(other.y - line.y) > line.size * 0.35 || other.x0 < end - 1) continue;
      if (other.x0 - end > line.size * 4) break;
      out.push(other);
      end = other.x1;
    }
    return out;
  };
  /**
   * A scrap of a fraction or a limit, close by a broken line: nearer than a
   * line of text could be, and short — though a row of denominators across a
   * sentence with two fractions in it runs to more than a word or two.
   */
  const scrap = (line: Line, near: Line) =>
    near.broken === true &&
    Math.abs(line.y - near.y) < leading * 0.9 &&
    (tiny(line) || (indented(line) && bare(line.text).length <= 24 && line.x1 - line.x0 < measure * 0.5));
  /**
   * A fraction's denominator, or the limits on a sum: set in, narrow, and
   * either holding maths or too short to be a sentence. The length test
   * matters because a paragraph's first line is indented too, and without it
   * every paragraph after an equation would be swallowed by it.
   */
  const fragment = (line: Line) =>
    indented(line) &&
    narrow(line) &&
    (line.math > 0 || (bare(line.text).length <= 12 && line.x1 - line.x0 < measure * 0.3));

  // A fraction set inside a sentence puts its numerator and denominator on
  // lines of their own, just above and below the sentence's baseline: the
  // sentence has to be copied out as it stands, fraction and all.
  // A denominator hangs about as far above the next line as it does below
  // its own, so the pieces are paired up first — numerator over denominator,
  // the two limits of an integral — and a pair belongs to the line between
  // its halves. A piece left over belongs to the nearest line.
  const tiny = (line: Line) => bare(line.text).length <= 12 && line.x1 - line.x0 < measure * 0.3;
  // The last few words of a paragraph are short, but stand at the margin.
  const sentences = lines.filter((line) => !tiny(line) || !indented(line));
  const holds = (line: Line, piece: Line) => {
    // The sentence goes on past the fraction, on the same baseline.
    const reach = Math.max(line.x1, ...rest(line).map((other) => other.x1));
    return piece.x0 >= line.x0 - line.size && piece.x1 <= reach + line.size && Math.abs(piece.y - line.y) < line.size * 0.9;
  };
  const nearest = (candidates: Line[], y: number) =>
    candidates.reduce<Line | undefined>((best, line) => (best === undefined || Math.abs(line.y - y) < Math.abs(best.y - y) ? line : best), undefined);
  // A numerator or a limit holds maths, a number, or a letter or two (the
  // b over an integral, the ? over an equals sign); a word or two in a
  // table's cell does not.
  const pieces = lines.filter(
    (line) => tiny(line) && indented(line) && (line.math > 0 || /\d/.test(line.text) || bare(line.text).length <= 2),
  );
  const owned = new Set<Line>();
  for (const up of pieces) {
    for (const down of pieces) {
      const drop = down.y - up.y;
      if (up === down || drop < up.size * 0.6 || drop > up.size * 2) continue;
      if (Math.min(up.x1, down.x1) <= Math.max(up.x0, down.x0) - up.size * 0.5) continue;
      const between = sentences.filter((line) => line.y > up.y && line.y <= down.y + line.size * 0.1 && holds(line, up) && holds(line, down));
      const owner = nearest(between, (up.y + down.y) / 2);
      if (!owner) continue;
      owner.broken = true;
      owned.add(up);
      owned.add(down);
    }
  }
  for (const piece of pieces) {
    if (owned.has(piece)) continue;
    const owner = nearest(
      sentences.filter((line) => holds(line, piece)),
      piece.y,
    );
    if (owner) owner.broken = true;
  }

  // A sentence gathers its own fractions first, so that a numerator set just
  // above it is not taken for a formula of its own.
  const order = [...lines.keys()].sort((a, b) => Number(prose(lines[b])) - Number(prose(lines[a])));
  for (const i of order) {
    if (consumed.has(lines[i]) || !display(lines[i])) continue;

    const start = lines[i];
    const block: Line[] = [start];
    let strongest = start.math;
    // A sentence with a fraction or an integral in it is copied out on its
    // own, with only the scraps of its own fractions: the equation displayed
    // under it is a separate thing, and is copied separately.
    const sentence = prose(lines[i]);
    const after = sentence ? rest(start) : [];
    let x0 = lines[i].x0;
    let x1 = Math.max(lines[i].x1, ...after.map((line) => line.x1));
    /**
     * Beside the formula rather than part of it: a label of a figure next to
     * it. Level with the formula and more than a label — long, or relating
     * one thing to another, or holding an integral sign itself — it is the
     * rest of the formula, however far along: past a big bracket or an
     * integral sign, which are drawn and leave a gap in the words.
     */
    const aside = (line: Line) => {
      if (line.x1 >= x0 - bodySize * 2 && line.x0 <= x1 + bodySize * 2) return false;
      const formula = (part: Line) => part.broken === true || !tiny(part) || RELATION.test(part.text);
      const level = block.some((part) => formula(part) && Math.abs(part.y - line.y) < part.size * 0.35);
      return !(level && formula(line));
    };
    const joins = (line: Line, near: Line) =>
      sentence
        ? scrap(line, near) || after.includes(line)
        : !prose(line) && (display(line) || fragment(line) || scrap(line, near));
    // Reach backwards for a numerator sitting above the first line found.
    for (let k = i - 1; k >= 0; k--) {
      const above = lines[k];
      if (block[0].y - above.y > leading * 1.35) break;
      if (!consumed.has(above) && aside(above)) continue;
      if (consumed.has(above) || !joins(above, block[0])) break;
      block.unshift(above);
      x0 = Math.min(x0, above.x0);
      x1 = Math.max(x1, above.x1);
    }
    // Then forwards, through the rest of the formula.
    for (let k = i + 1; k < lines.length; k++) {
      const below = lines[k];
      if (consumed.has(below)) break;
      const gap = below.y - block[block.length - 1].y;
      if (gap > leading * 1.9) break;
      if (aside(below)) continue;
      if (!joins(below, block[block.length - 1])) break;
      block.push(below);
      x0 = Math.min(x0, below.x0);
      x1 = Math.max(x1, below.x1);
      strongest = Math.max(strongest, below.math);
    }
    // A piece passed over as lying to one side of the first line found may
    // be inside the formula once the formula is known in full: the first row
    // of a determinant, the numerators of a row of fractions.
    for (let grew = true; grew; ) {
      grew = false;
      const top = Math.min(...block.map((line) => line.y)) - leading * 0.9;
      const bottom = Math.max(...block.map((line) => line.y)) + leading * 0.9;
      for (const line of lines) {
        if (consumed.has(line) || block.includes(line) || line.y < top || line.y > bottom) continue;
        // Within the formula's own width: anything reaching out beyond it
        // is something else set alongside — unless it is a mere scrap, the
        // "+ · · ·" at the end, a bracket's exponent.
        const within = line.x0 >= x0 - bodySize && line.x1 <= x1 + bodySize;
        if (!(within || (tiny(line) && !aside(line))) || !joins(line, start)) continue;
        block.push(line);
        x0 = Math.min(x0, line.x0);
        x1 = Math.max(x1, line.x1);
        strongest = Math.max(strongest, line.math);
        grew = true;
      }
    }

    // A centred heading is indented and narrow too, so insist on real maths.
    if (strongest < 0.4 && block.length < 2 && !block[0].broken) continue;
    if (!block.some((line) => line.broken) && isLabel(block)) continue;

    for (const line of block) consumed.add(line);
    boxes.push(around(block, bodySize));
    blocks.push(block);
    sentenceBlocks.push(sentence);
  }

  return { boxes, blocks, prose: sentenceBlocks, consumed };
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
