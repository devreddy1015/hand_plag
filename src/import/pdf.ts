/**
 * Reading a PDF back into plain, structured text.
 *
 * pdf.js parses the file in its own worker and hands back positioned runs of
 * text; `reflow.ts` turns those back into a document. Everything happens in
 * the browser, so the file never leaves the device.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { buildLines, reconstruct, DEFAULT_PDF_OPTIONS, type PageLines, type PdfOptions } from './reflow';
import type { Importer } from './shared';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PdfOptions } from './reflow';

export const importPdf: Importer<Partial<PdfOptions>> = async (file, onProgress, options) => {
  const opts = { ...DEFAULT_PDF_OPTIONS, ...options };
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;

  try {
    const pages: PageLines[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        index: i - 1,
        width: viewport.width,
        height: viewport.height,
        lines: buildLines(content.items as TextItem[], viewport.height, viewport.width),
      });
      page.cleanup();
      onProgress?.(i, doc.numPages);
    }

    if (pages.every((p) => p.lines.length === 0)) {
      return {
        text: '',
        pageCount: doc.numPages,
        warnings: [
          'This PDF holds no text, only page images \u2014 it was scanned or exported as pictures. Run it through OCR first, or paste the text in.',
        ],
      };
    }

    const { text, warnings } = reconstruct(pages, opts);
    return { text, pageCount: doc.numPages, warnings };
  } finally {
    await task.destroy();
  }
};
