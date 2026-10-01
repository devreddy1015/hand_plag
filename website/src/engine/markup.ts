/**
 * Turning a plain-text document into blocks the layout can write.
 *
 * The markup is a small, familiar subset of Markdown, chosen because it is
 * what a person types (or what the PDF/DOCX importer can recover) and because
 * every part of it has an obvious handwritten equivalent:
 *
 *   # Heading        bigger letters, underlined by hand
 *   - item           a hand-drawn bullet and a hanging indent
 *   1. item          a written number and a hanging indent
 *   > quote          indented on both sides
 *   ---              a ruled-off divider
 *   **important**    pressed harder, so the ink is heavier
 *   _slanted_        leaned over further
 *   __underlined__   underlined by hand
 *   x^2, x^{n+1}     written small and raised
 *   H_2O, x_{i}      written small and dropped
 *   ![caption](id)   a diagram, drawn out and captioned
 *   [[page]]         start a new sheet
 *
 * With `markdown: false` only `[[page]]` is honoured and everything else is
 * written literally, so pasted text that happens to contain `#` or `*` is
 * never silently reinterpreted. Unicode superscripts and subscripts (², ₂)
 * are always written as small raised or dropped figures, since no hand has a
 * separate letter for them.
 */

/** A line containing only this marker starts a new page. */
export const PAGE_BREAK = /^\s*\[\[page\]\]\s*$/i;

export type BlockKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'divider' | 'blank' | 'pagebreak' | 'image' | 'caption';

/** Emphasis bits, one entry per character of `Block.text`. */
export const EM_BOLD = 1;
export const EM_ITALIC = 2;
export const EM_UNDERLINE = 4;
export const EM_SUP = 8;
export const EM_SUB = 16;

export interface Block {
  kind: BlockKind;
  /** Heading level 1-3. */
  level: number;
  /** The text to write, with inline markers removed. */
  text: string;
  /** Emphasis bits per character of `text`, or null when there is none. */
  emphasis: Uint8Array | null;
  /** Written before the text, on the first line only (bullets, numbers). */
  marker: string;
  /** Image blocks: the key of the picture to draw. */
  src: string;
  /** Leading whitespace of the source line, in spaces (tabs count as four). */
  indentSpaces: number;
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^([-*+•‣·])\s+(.*)$/;
const NUMBERED = /^(\(?\d{1,3}[.)]|[ivxlIVXL]{1,5}[.)]|[a-zA-Z][.)])\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
/** A diagram on a line of its own: ![caption](id) */
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const DIVIDER = /^\s*([-*_=]\s?){3,}\s*$/;

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n += 1;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

function block(kind: BlockKind, text: string, extra: Partial<Block> = {}): Block {
  return { kind, level: 0, text, emphasis: null, marker: '', indentSpaces: 0, src: '', ...extra };
}

/** Split a document into blocks. Each block is written starting on a new line. */
export function parseBlocks(text: string, markdown: boolean): Block[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    // Control codes and private-use points have no letter in any hand: left
    // in, the browser would write its "missing letter" box on the page.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ue000-\uf8ff]/g, '')
    .split('\n');
  const out: Block[] = [];

  for (const raw of lines) {
    if (PAGE_BREAK.test(raw)) {
      out.push(block('pagebreak', ''));
      continue;
    }
    const indentSpaces = leadingSpaces(raw);
    const line = raw.trim();
    if (line === '') {
      out.push(block('blank', ''));
      continue;
    }
    const image = IMAGE.exec(line);
    if (image) {
      out.push(block('image', '', { src: image[2] }));
      // The caption is written under the diagram, in a smaller hand.
      if (image[1].trim() !== '') out.push(withInline(block('caption', image[1].trim()), markdown));
      continue;
    }
    if (!markdown) {
      out.push(withInline(block('paragraph', line, { indentSpaces }), false));
      continue;
    }
    if (DIVIDER.test(raw)) {
      out.push(block('divider', ''));
      continue;
    }
    let m = HEADING.exec(line);
    if (m) {
      out.push(withInline(block('heading', m[2].trim(), { level: m[1].length }), true));
      continue;
    }
    m = QUOTE.exec(line);
    if (m) {
      out.push(withInline(block('quote', m[1].trim(), { indentSpaces }), true));
      continue;
    }
    m = BULLET.exec(line);
    if (m) {
      out.push(withInline(block('list', m[2].trim(), { marker: '•', indentSpaces }), true));
      continue;
    }
    m = NUMBERED.exec(line);
    if (m) {
      // Keep the writer's own numbering rather than renumbering the list.
      out.push(withInline(block('list', m[2].trim(), { marker: m[1].replace(/^\(/, ''), indentSpaces }), true));
      continue;
    }
    out.push(withInline(block('paragraph', line, { indentSpaces }), true));
  }

  // Trim trailing blank lines so a document doesn't end on empty pages.
  while (out.length > 0 && out[out.length - 1].kind === 'blank') out.pop();
  return out;
}

interface Rule {
  re: RegExp;
  bits: number;
}

// Longest markers first: ** and __ must win over * and _.
const INLINE_RULES: Rule[] = [
  { re: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, bits: EM_BOLD | EM_ITALIC },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/g, bits: EM_BOLD },
  { re: /__(?=\S)([\s\S]*?\S)__/g, bits: EM_UNDERLINE },
  { re: /(?<![\p{L}\p{N}])\*(?=\S)([^*]*?\S)\*(?![\p{L}\p{N}])/gu, bits: EM_ITALIC },
  { re: /(?<![\p{L}\p{N}\p{M}])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}])/gu, bits: EM_ITALIC },
  { re: /`(?=\S)([^`]*?)`/g, bits: 0 },
];

const LINK = /\[([^\]]+)\]\((?:[^)\s]+)(?:\s+"[^"]*")?\)/g;

// Superscripts and subscripts. The short forms are kept to what is
// unambiguous in running text: a caret is rarely anything else, but an
// underscore sits inside names, so only digits follow one without braces.
// A letter may wear an accent — the bar of Ā — before its script.
const SCRIPT_RULES: Rule[] = [
  { re: /\^\{([^{}]+)\}/g, bits: EM_SUP },
  { re: /(?<=[\p{L}\p{N}\p{M})\]])_\{([^{}]+)\}/gu, bits: EM_SUB },
  { re: /(?<=[\p{L}\p{N}\p{M})\]])\^([+-]?(?:\d+(?:\.\d+)?|\p{L}+))/gu, bits: EM_SUP },
  { re: /(?<=[\p{L}\p{M})\]])_(\d+)/gu, bits: EM_SUB },
];

const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
};
const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x',
  'ₕ': 'h', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't',
};
const UNICODE_SCRIPT = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ₀-₎ₐₑₒₓₕₖₗₘₙₚₛₜ]/;

/**
 * Strip inline markers from a block and record which characters they
 * emphasised. Runs the rules one at a time over the whole string so nested
 * markers (`**bold _and slanted_**`) keep both flags.
 */
function withInline(b: Block, markdown: boolean): Block {
  const scripts = UNICODE_SCRIPT.test(b.text);
  if (!scripts && (!markdown || !/[*_`[^]/.test(b.text))) return b;

  let text = markdown ? b.text.replace(LINK, '$1') : b.text;
  let flags = new Uint8Array(text.length);
  let touched = false;

  if (scripts) {
    // One character for one, so the flags stay in step with the text.
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const sup = SUPERSCRIPTS[ch];
      const sub = SUBSCRIPTS[ch];
      if (sup !== undefined) flags[i] |= EM_SUP;
      if (sub !== undefined) flags[i] |= EM_SUB;
      out += sup ?? sub ?? ch;
    }
    text = out;
    touched = true;
  }

  for (const rule of markdown ? [...SCRIPT_RULES, ...INLINE_RULES] : []) {
    let out = '';
    const next: number[] = [];
    let last = 0;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const inner = m[1];
      for (let i = last; i < m.index; i++) next.push(flags[i]);
      out += text.slice(last, m.index);
      // Markers may differ at each end (^{ and }), so find the inner text itself.
      const innerStart = m.index + m[0].indexOf(inner);
      for (let i = 0; i < inner.length; i++) next.push(flags[innerStart + i] | rule.bits);
      out += inner;
      last = m.index + m[0].length;
      touched = touched || rule.bits !== 0;
    }
    if (last === 0) continue; // rule didn't match: keep the string as it is
    for (let i = last; i < text.length; i++) next.push(flags[i]);
    out += text.slice(last);
    text = out;
    flags = Uint8Array.from(next);
  }

  b.text = text;
  b.emphasis = touched ? flags : null;
  return b;
}
