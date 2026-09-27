/**
 * Reading a .docx back into structured text.
 *
 * A .docx is a zip of XML. `word/document.xml` holds the body, and
 * `word/numbering.xml` says whether a numbered list is bulleted or counted, so
 * lists come out the way the author wrote them. Only the parts that survive
 * being written by hand are kept: headings, paragraphs, lists, emphasis, page
 * breaks and table rows.
 */
import { unzipSync } from 'fflate';
import { cleanText, type Importer } from './shared';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export const importDocx: Importer = async (file, onProgress) => {
  onProgress?.(0, 2);
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (f) => f.name === 'word/document.xml' || f.name === 'word/numbering.xml',
  });
  const body = zip['word/document.xml'];
  if (!body) throw new Error('This .docx has no word/document.xml, so it cannot be read.');
  onProgress?.(1, 2);

  const decoder = new TextDecoder();
  const parser = new DOMParser();
  const doc = parser.parseFromString(decoder.decode(body), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The document XML inside this .docx is damaged.');

  const numbering = zip['word/numbering.xml']
    ? numberFormats(parser.parseFromString(decoder.decode(zip['word/numbering.xml']), 'application/xml'))
    : new Map<string, string>();

  const out: string[] = [];
  const warnings: string[] = [];
  const counters = new Map<string, number>();
  let pages = 1;

  const root = doc.getElementsByTagNameNS(W, 'body')[0] ?? doc.documentElement;
  for (const node of Array.from(root.children)) {
    const name = node.localName;
    if (name === 'p') {
      const { text, pageBreak } = paragraph(node, numbering, counters);
      if (pageBreak) {
        out.push('[[page]]');
        pages++;
      }
      if (text !== '') out.push(text);
    } else if (name === 'tbl') {
      const rows = tableRows(node);
      if (rows.length > 0) {
        out.push(...rows);
        warnings.push('A table was written out row by row, separated by “|”.');
      }
    }
  }
  onProgress?.(2, 2);

  const text = out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, pageCount: pages, warnings: [...new Set(warnings)] };
};

/** numId → number format of its first level ("bullet", "decimal", ...). */
function numberFormats(doc: XMLDocument): Map<string, string> {
  const abstractFormat = new Map<string, string>();
  for (const abstract of Array.from(doc.getElementsByTagNameNS(W, 'abstractNum'))) {
    const id = abstract.getAttributeNS(W, 'abstractNumId');
    const level = Array.from(abstract.getElementsByTagNameNS(W, 'lvl')).find((l) => l.getAttributeNS(W, 'ilvl') === '0');
    const fmt = level?.getElementsByTagNameNS(W, 'numFmt')[0]?.getAttributeNS(W, 'val');
    if (id && fmt) abstractFormat.set(id, fmt);
  }
  const formats = new Map<string, string>();
  for (const num of Array.from(doc.getElementsByTagNameNS(W, 'num'))) {
    const id = num.getAttributeNS(W, 'numId');
    const abstractId = num.getElementsByTagNameNS(W, 'abstractNumId')[0]?.getAttributeNS(W, 'val');
    if (id && abstractId) formats.set(id, abstractFormat.get(abstractId) ?? 'decimal');
  }
  return formats;
}

interface ParagraphResult {
  text: string;
  pageBreak: boolean;
  listKey: string | null;
  level: number;
}

function paragraph(p: Element, numbering: Map<string, string>, counters: Map<string, number>): ParagraphResult {
  const props = p.getElementsByTagNameNS(W, 'pPr')[0];
  const styleId = props?.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') ?? '';
  const numPr = props?.getElementsByTagNameNS(W, 'numPr')[0];
  const numId = numPr?.getElementsByTagNameNS(W, 'numId')[0]?.getAttributeNS(W, 'val') ?? null;
  const ilvl = Number(numPr?.getElementsByTagNameNS(W, 'ilvl')[0]?.getAttributeNS(W, 'val') ?? 0);

  let pageBreak = false;
  let text = '';
  for (const run of Array.from(p.getElementsByTagNameNS(W, 'r'))) {
    const rPr = run.getElementsByTagNameNS(W, 'rPr')[0];
    const bold = hasToggle(rPr, 'b');
    const italic = hasToggle(rPr, 'i');
    const underline = (rPr?.getElementsByTagNameNS(W, 'u')[0]?.getAttributeNS(W, 'val') ?? 'none') !== 'none';
    let piece = '';
    for (const child of Array.from(run.children)) {
      if (child.localName === 't') piece += child.textContent ?? '';
      else if (child.localName === 'tab') piece += '\t';
      else if (child.localName === 'br') {
        if (child.getAttributeNS(W, 'type') === 'page') pageBreak = true;
        else piece += ' ';
      } else if (child.localName === 'noBreakHyphen') piece += '-';
    }
    if (piece.trim() === '') {
      text += piece;
      continue;
    }
    // Keep the spaces around the run outside the emphasis markers.
    const [lead] = /^\s*/.exec(piece)!;
    const [tail] = /\s*$/.exec(piece)!;
    let core = piece.slice(lead.length, piece.length - tail.length);
    if (bold) core = `**${core}**`;
    if (italic) core = `_${core}_`;
    if (underline && !bold && !italic) core = `__${core}__`;
    text += lead + core + tail;
  }

  text = cleanText(text);
  if (text === '') return { text: '', pageBreak, listKey: null, level: 0 };

  const heading = /^Heading([1-9])$/i.exec(styleId) ?? (/^Title$/i.test(styleId) ? [null, '1'] : null);
  if (heading) return { text: `${'#'.repeat(Math.min(3, Number(heading[1])))} ${text}`, pageBreak, listKey: null, level: Number(heading[1]) };

  if (numId) {
    const key = `${numId}:${ilvl}`;
    const bulleted = (numbering.get(numId) ?? 'bullet') === 'bullet';
    const indent = '  '.repeat(Math.min(3, ilvl));
    if (bulleted) return { text: `${indent}- ${text}`, pageBreak, listKey: key, level: ilvl };
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return { text: `${indent}${next}. ${text}`, pageBreak, listKey: key, level: ilvl };
  }

  if (/^(Quote|IntenseQuote)$/i.test(styleId)) return { text: `> ${text}`, pageBreak, listKey: null, level: 0 };
  return { text, pageBreak, listKey: null, level: 0 };
}

function hasToggle(rPr: Element | undefined, tag: string): boolean {
  const el = rPr?.getElementsByTagNameNS(W, tag)[0];
  if (!el) return false;
  const val = el.getAttributeNS(W, 'val');
  return val === null || val === '1' || val === 'true' || val === 'on';
}

function tableRows(tbl: Element): string[] {
  const rows: string[] = [];
  for (const tr of Array.from(tbl.getElementsByTagNameNS(W, 'tr'))) {
    const cells: string[] = [];
    for (const tc of Array.from(tr.getElementsByTagNameNS(W, 'tc'))) {
      const text = cleanText(
        Array.from(tc.getElementsByTagNameNS(W, 't'))
          .map((t) => t.textContent ?? '')
          .join(' '),
      );
      cells.push(text);
    }
    const line = cells.join(' | ').trim();
    if (line.replace(/[|\s]/g, '') !== '') rows.push(line);
  }
  return rows;
}
