import { PDFDocument } from 'pdf-lib';
import { createCanvas, drawPage, type Prepared } from '../pipeline';
import { canvasToBlob, nextFrame, type Progress } from './download';

const PT_PER_MM = 72 / 25.4;

/** One PDF page per handwritten page, each an image at the chosen DPI. */
export async function exportPdf(prepared: Prepared, dpi: number, onProgress: Progress, signal?: AbortSignal): Promise<Blob> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Handwritten document');
  pdf.setCreator('Handscript');
  pdf.setProducer('Handscript (pdf-lib)');

  const { geometry, pages } = prepared.doc;
  const widthPt = geometry.widthMm * PT_PER_MM;
  const heightPt = geometry.heightMm * PT_PER_MM;
  const canvas = createCanvas(1, 1) as HTMLCanvasElement;
  const scale = dpi / 96;

  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    drawPage(canvas, prepared, i, scale);
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    const image = await pdf.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    const page = pdf.addPage([widthPt, heightPt]);
    page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
    onProgress(i + 1, pages.length);
    await nextFrame();
  }

  const bytes = await pdf.save();
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
