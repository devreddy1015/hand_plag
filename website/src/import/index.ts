/**
 * Getting text out of the files people actually have: PDF, Word, plain text
 * and Markdown. The PDF and Word readers are loaded on first use, so a visitor
 * who only types never downloads them.
 */
import { cleanText, readTextFile, reflowHardWraps, type ImportResult, type Progress } from './shared';
import type { PdfOptions } from './pdf';

export type { ImportResult, Progress } from './shared';
export type { PdfOptions } from './pdf';

export type ImportKind = 'pdf' | 'docx' | 'text' | 'unsupported';

export function detectKind(file: File): ImportKind {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (/\.(txt|md|markdown|text|csv|tex|rtf)$/.test(name) || file.type.startsWith('text/')) return 'text';
  if (name.endsWith('.doc')) return 'unsupported';
  return file.type === '' ? 'text' : 'unsupported';
}

export interface ImportOptions {
  pdf?: Partial<PdfOptions>;
}

/** Read one file into structured text, whatever kind it is. */
export async function importDocument(file: File, onProgress?: Progress, options: ImportOptions = {}): Promise<ImportResult> {
  const kind = detectKind(file);
  if (kind === 'unsupported') {
    throw new Error(
      file.name.toLowerCase().endsWith('.doc')
        ? 'Old .doc files cannot be read here. Save it as .docx or PDF and try again.'
        : `${file.name} is not a kind of document this can read. Use a PDF, .docx, .txt or .md file.`,
    );
  }
  if (kind === 'pdf') {
    const { importPdf } = await import('./pdf');
    return importPdf(file, onProgress, options.pdf);
  }
  if (kind === 'docx') {
    const { importDocx } = await import('./docx');
    return importDocx(file, onProgress);
  }
  const raw = await readTextFile(file);
  onProgress?.(1, 1);
  const tidy = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => cleanText(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // A file wrapped at column 72 should still be written as flowing paragraphs.
  const text = reflowHardWraps(tidy);
  const warnings = text === tidy ? [] : ['Joined the hard-wrapped lines back into paragraphs.'];
  return { text, pageCount: 0, warnings };
}
