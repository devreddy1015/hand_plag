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
  /** Index in the paragraph of the first character of this token. */
  offset: number;
}

/**
 * Break a paragraph into tokens. Words split on whitespace; runs of Chinese or
 * Japanese split per character so lines can wrap between any two of them.
 */
export function tokenize(paragraph: string, forceShaped = false): Token[] {
  const tokens: Token[] = [];
  let pendingSpaces = 0;
  let pos = 0;
  for (const piece of paragraph.split(/(\s+)/)) {
    const at = pos;
    pos += piece.length;
    if (piece === '') continue;
    if (/^\s+$/.test(piece)) {
      for (const ch of piece) pendingSpaces += ch === '\t' ? 4 : 1;
      continue;
    }
    if (!forceShaped && PRINTABLE_ASCII.test(piece)) {
      tokens.push({ units: piece.split(''), spacesBefore: pendingSpaces, shaped: false, offset: at });
      pendingSpaces = 0;
      continue;
    }
    const shaped = forceShaped || needsShaping(piece);
    if (shaped) {
      tokens.push({ units: [piece], spacesBefore: pendingSpaces, shaped: true, offset: at });
      pendingSpaces = 0;
      continue;
    }
    // Group clusters: consecutive non-CJK clusters form one word; each CJK
    // cluster stands alone so the line can break around it.
    let run: string[] = [];
    let runAt = at;
    let cursor = at;
    let first = true;
    const flush = () => {
      if (run.length === 0) return;
      tokens.push({ units: run, spacesBefore: first ? pendingSpaces : 0, shaped: false, offset: runAt });
      first = false;
      run = [];
    };
    for (const cluster of graphemes(piece)) {
      if (BREAK_ANYWHERE.test(cluster)) {
        flush();
        tokens.push({ units: [cluster], spacesBefore: first ? pendingSpaces : 0, shaped: false, offset: cursor });
        first = false;
      } else {
        if (run.length === 0) runAt = cursor;
        run.push(cluster);
      }
      cursor += cluster.length;
    }
    flush();
    pendingSpaces = 0;
  }
  return tokens;
}

const VOWEL = /[aeiouyàáâäãåèéêëìíîïòóôöõùúûüāēīōū]/i;
const LETTER = /\p{L}/u;

/**
 * Where a writer would break a long word across two lines, preferring the
 * candidate closest to (but not after) `target`. Returns 0 when the word
 * should not be broken.
 *
 * The rules are the ones people actually use by ear: keep at least two
 * letters on each line, break between two consonants or after a vowel, and
 * never split a digit run or a hyphenated compound in the wrong place.
 */
export function hyphenPoint(units: string[], target: number): number {
  const n = units.length;
  if (n < 6 || target < 3) return 0;
  const limit = Math.min(target, n - 3);
  let best = 0;
  let bestScore = -1;
  for (let i = 3; i <= limit; i++) {
    const prev = units[i - 1];
    const next = units[i];
    if (!LETTER.test(prev) || !LETTER.test(next)) continue;
    if (prev === next) continue; // don't split a doubled letter pair badly
    const prevVowel = VOWEL.test(prev);
    const nextVowel = VOWEL.test(next);
    let score = 1;
    if (!prevVowel && !nextVowel) score = 4; // between two consonants: cleanest
    else if (prevVowel && !nextVowel) score = 3; // after a vowel
    else if (!prevVowel && nextVowel) score = 2;
    // Prefer breaks close to the end of the available room.
    score += (i / limit) * 1.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Sentence-ending punctuation gets a wider gap after it, as in real writing. */
export function gapAfterFactor(word: string): number {
  const last = word.slice(-1);
  if (last === '.' || last === '!' || last === '?' || last === '…') return 1.35;
  if (last === ',' || last === ';' || last === ':') return 1.15;
  return 1;
}

/** A leading opening bracket or quote is written tight against its word. */
export function gapBeforeFactor(word: string): number {
  const first = word.slice(0, 1);
  if (first === '(' || first === '[' || first === '“' || first === '"') return 1.1;
  return 1;
}

/**
 * What a person writes for a typed character that a hand has no letter for.
 * Typesetting has its own characters — curly quotes, dashes of three
 * lengths, a single glyph for an ellipsis — that handwriting never had: a
 * writer puts down two ticks, a short stroke, three dots.
 */
const WRITTEN_FORMS: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': ',',
  '\u201b': "'",
  '\u2032': "'",
  '\u02bc': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2033': '"',
  '\u00ab': '"',
  '\u00bb': '"',
  '\u2039': "'",
  '\u203a': "'",
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u2026': '...',
  '\u2022': '-',
  '\u2023': '-',
  '\u25e6': '-',
  '\u00b7': '.',
  '\u00d7': 'x',
  '\u00f7': '/',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2260': '=/=',
  '\u2192': '->',
  '\u2190': '<-',
  '\u21d2': '=>',
  '\u00b1': '+/-',
  '\u00a9': '(c)',
  '\u00ae': '(R)',
  '\u2122': 'TM',
  '\u00bd': '1/2',
  '\u00bc': '1/4',
  '\u00be': '3/4',
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
};

/** The plain written form of a typographic character, or the unit itself. */
export function writtenForm(unit: string): string {
  return WRITTEN_FORMS[unit] ?? unit;
}
