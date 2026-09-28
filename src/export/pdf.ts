import { PDFDocument } from 'pdf-lib';
import { releaseLayers, releaseSketches } from '../engine';
import { createCanvas, drawPage } from '../pipeline';
import { canvasToBlob, jpegQuality, nextFrame, type ExportJob } from './download';

const PT_PER_MM = 72 / 25.4;

/**
 * One PDF page per handwritten page, each an image at the chosen resolution.
 *
 * The pages are pictures on purpose: the whole point is a sheet of paper with
 * ink on it, and a picture is what a scanner or a camera would have produced.
 * JPEG is used because a page of ink on textured paper is a photograph, not
 * line art; PNG is offered for anyone who wants it untouched.
 */
export async function exportPdf(job: ExportJob): Promise<Blob> {
  const { prepared, dpi, onProgress, signal } = job;
  // The file says what it is called and nothing about how it was made: no
  // creator or producer stamp, which is what a page off a scanner carries.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  if (job.title) pdf.setTitle(job.title);

  const canvas = createCanvas(1, 1) as HTMLCanvasElement;
  const scale = dpi / 96;
  const pages = job.pages ?? prepared.doc.pages.map((_, i) => i);
  const lossless = job.format === 'png';

  try {
    for (let n = 0; n < pages.length; n++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const index = pages[n];
      const geom = prepared.doc.geometryOf(index);
      drawPage(canvas, prepared, index, scale);
      const blob = lossless
        ? await canvasToBlob(canvas, 'image/png')
        : await canvasToBlob(canvas, 'image/jpeg', jpegQuality(dpi));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const image = lossless ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const widthPt = geom.widthMm * PT_PER_MM;
      const heightPt = geom.heightMm * PT_PER_MM;
      const page = pdf.addPage([widthPt, heightPt]);
      page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
      onProgress(n + 1, pages.length);
      await nextFrame();
    }

    const bytes = await pdf.save();
    return new Blob([bytes as BlobPart], { type: 'application/pdf' });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    releaseLayers();
    releaseSketches();
  }
}
