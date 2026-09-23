/**
 * Splitting text into drawable units.
 *
 * Latin, Cyrillic, Greek and CJK are drawn one grapheme cluster at a time so
 * every letter can wobble on its own. Scripts whose letters join or reorder
 * (Arabic, Hebrew, Indic, Thai, ...) are drawn a whole word at a time so the
 * browser can shape them correctly; they get word-level jitter instead.
 */

const SHAPED_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}]/u;

/** Scripts written without spaces, where a line may break between any two characters. */
const BREAK_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

const RTL_CHAR = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const STRONG_LTR = /[\p{L}]/u;

export type ScriptTag =
  | 'latin'
  | 'cyrillic'
  | 'greek'
  | 'devanagari'
  | 'arabic'
  | 'hebrew'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'other';

const SCRIPT_TESTS: [ScriptTag, RegExp][] = [
  ['latin', /\p{Script=Latin}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['han', /\p{Script=Han}/u],
  ['hangul', /\p{Script=Hangul}/u],
];

/** Script of the first letter in a unit, or null for digits, punctuation and symbols. */
export function scriptOf(unit: string): ScriptTag | null {
  for (const ch of unit) {
    if (!/\p{L}/u.test(ch)) continue;
    for (const [tag, re] of SCRIPT_TESTS) if (re.test(ch)) return tag;
    return 'other';
  }
  return null;
}

/** Which scripts appear in the text. Used to pick fallback handwriting fonts. */
export function detectScripts(text: string): Set<ScriptTag> {
  const found = new Set<ScriptTag>();
  for (const [tag, re] of SCRIPT_TESTS) if (re.test(text)) found.add(tag);
  return found;
}

let segmenter: Intl.Segmenter | null | undefined;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Split a string into user-perceived characters (grapheme clusters). */
export function graphemes(text: string): string[] {
  // Plain ASCII has one character per cluster; skip the (slow) segmenter.
  if (PRINTABLE_ASCII.test(text)) return text.split('');
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

export function needsShaping(word: string): boolean {
  return SHAPED_SCRIPT.test(word);
}

/** True when the paragraph's first strong character is right-to-left. */
export function isRtlParagraph(text: string): boolean {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return true;
    if (STRONG_LTR.test(ch)) return false;
  }
  return false;
}

export interface Token {
  /** Unit strings to draw. One entry for shaped words, one per cluster otherwise. */
  units: string[];
  /** Number of spaces written before this token (0 when glued to the previous one). */
  spacesBefore: number;
  /** Drawn as one shaped unit. */
  shaped: boolean;
}

/**
 * Break a paragraph into tokens. Words split on whitespace; runs of Chinese or
 * Japanese split per character so lines can wrap between any two of them.
 */
export function tokenize(paragraph: string, forceShaped = false): Token[] {
  const tokens: Token[] = [];
  let pendingSpaces = 0;
  for (const piece of paragraph.split(/(\s+)/)) {
    if (piece === '') continue;
    if (/^\s+$/.test(piece)) {
      for (const ch of piece) pendingSpaces += ch === '\t' ? 4 : 1;
      continue;
    }
    if (!forceShaped && PRINTABLE_ASCII.test(piece)) {
      tokens.push({ units: piece.split(''), spacesBefore: pendingSpaces, shaped: false });
      pendingSpaces = 0;
      continue;
    }
    const shaped = forceShaped || needsShaping(piece);
    if (shaped) {
      tokens.push({ units: [piece], spacesBefore: pendingSpaces, shaped: true });
      pendingSpaces = 0;
      continue;
    }
    // Group clusters: consecutive non-CJK clusters form one word; each CJK
    // cluster stands alone so the line can break around it.
    let run: string[] = [];
    let first = true;
    const flush = () => {
      if (run.length === 0) return;
      tokens.push({ units: run, spacesBefore: first ? pendingSpaces : 0, shaped: false });
      first = false;
      run = [];
    };
    for (const cluster of graphemes(piece)) {
      if (BREAK_ANYWHERE.test(cluster)) {
        flush();
        tokens.push({ units: [cluster], spacesBefore: first ? pendingSpaces : 0, shaped: false });
        first = false;
      } else {
        run.push(cluster);
      }
    }
    flush();
    pendingSpaces = 0;
  }
  return tokens;
}
