/** Pieces shared by the file importers. */

/** A picture taken out of a document, ready to be drawn on the page. */
export interface ImportedImage {
  /** Key referred to by `![caption](id)` in the text. */
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface ImportResult {
  /** Structured plain text, ready for the layout engine. */
  text: string;
  /** Pages in the source document, where it had any. */
  pageCount: number;
  /** Things worth telling the reader about (dropped headers, missing text). */
  warnings: string[];
  /** Diagrams found in the document, keyed by the ids used in `text`. */
  images?: ImportedImage[];
}

export type Progress = (done: number, total: number) => void;

export type Importer<Options = void> = (file: File, onProgress?: Progress, options?: Options) => Promise<ImportResult>;

const LIGATURES: [RegExp, string][] = [
  [/\ufb00/g, 'ff'],
  [/\ufb01/g, 'fi'],
  [/\ufb02/g, 'fl'],
  [/\ufb03/g, 'ffi'],
  [/\ufb04/g, 'ffl'],
  [/[\ufb05\ufb06]/g, 'st'],
  [/\u0132/g, 'IJ'],
  [/\u0133/g, 'ij'],
];

/**
 * Tidy a run of extracted text: expand the ligatures a typesetter used, drop
 * the invisible characters that only mattered to the layout it came from, and
 * settle the many kinds of space and hyphen back to one of each.
 */
export function cleanText(input: string): string {
  let text = input;
  for (const [re, to] of LIGATURES) text = text.replace(re, to);
  text = text
    .replace(/\u00ad/g, '') // soft hyphen: a break that no longer applies
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[\u2010\u2011]/g, '-')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u2028\u2029]/g, ' ')
    // Control characters, but keep tab and newline.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1');
  return text.trim();
}

/**
 * Join the lines of one paragraph. A word broken across a line break with a
 * hyphen is put back together; everything else is joined with a space.
 */
export function joinBroken(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (out === '') {
      out = line;
      continue;
    }
    // A hyphen at a line end is usually where a word was broken — unless what
    // follows is itself hyphenated, as in "state-" + "of-the-art".
    const compound = /^[^\s]*-/.test(line);
    const broken = /[a-zà-öø-ÿ]-$/.test(out) && /^[a-zà-öø-ÿ]/.test(line) && !compound;
    out = broken ? out.slice(0, -1) + line : `${out} ${line}`;
  }
  return out;
}

/** Read a text file, guessing UTF-8 and falling back to Latin-1. */
export async function readTextFile(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  // U+FFFD in quantity means it was not UTF-8 after all.
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 0 && bad > utf8.length * 0.002) return new TextDecoder('windows-1252').decode(buffer);
  return utf8.replace(/^﻿/, '');
}

/**
 * Undo hard line wrapping.
 *
 * Plain text files and older Word documents often break every line at column
 * 72. Written out by hand that reads as a stack of short paragraphs, so the
 * lines of each paragraph are joined back together — but only when the file
 * really is wrapped that way, judged by how many lines run long and stop in
 * the middle of a sentence. Headings, list items and blank lines are left
 * exactly as they are.
 */
export function reflowHardWraps(text: string): string {
  const lines = text.split('\n');
  const body = lines.map((l) => l.trim()).filter((l) => l !== '');
  if (body.length < 6) return text;

  const lengths = [...body.map((l) => l.length)].sort((a, b) => a - b);
  const wrapWidth = lengths[Math.floor(lengths.length * 0.9)];
  if (wrapWidth < 40 || wrapWidth > 200) return text;
  const long = body.filter((l) => l.length > wrapWidth * 0.8).length / body.length;
  const unfinished = body.filter((l) => !/[.!?:;"'’”)\]]$/.test(l)).length / body.length;
  if (long < 0.5 || unfinished < 0.35) return text;

  const STRUCTURE = /^(#{1,6}\s|[-*+•‣]\s|\d{1,3}[.)]\s|>\s|\|)|^\[\[page\]\]$|^`{3}/;
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) out.push(joinBroken(buffer));
    buffer = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || STRUCTURE.test(line)) {
      flush();
      out.push(raw);
      continue;
    }
    buffer.push(line);
    // A line that stops well short of the wrap width ended its paragraph.
    if (line.length < wrapWidth * 0.72) flush();
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
