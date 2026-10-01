import { zipSync, type Zippable } from 'fflate';
import { releaseLayers, releaseSketches } from '../engine';
import { createCanvas, drawPage } from '../pipeline';
import { canvasToBlob, jpegQuality, nextFrame, type ExportJob } from './download';

/** A PNG for a single page, or a ZIP of numbered PNGs for several. */
export async function exportPng(job: ExportJob): Promise<{ blob: Blob; filename: string }> {
  const { prepared, dpi, onProgress, signal } = job;
  const canvas = createCanvas(1, 1) as HTMLCanvasElement;
  const scale = dpi / 96;
  const pages = job.pages ?? prepared.doc.pages.map((_, i) => i);
  const base = job.title ?? 'handwriting';
  const jpeg = job.format === 'jpeg';
  const extension = jpeg ? 'jpg' : 'png';
  const encode = (c: HTMLCanvasElement) => (jpeg ? canvasToBlob(c, 'image/jpeg', jpegQuality(dpi)) : canvasToBlob(c, 'image/png'));

  try {
    if (pages.length === 1) {
      drawPage(canvas, prepared, pages[0], scale);
      const blob = await encode(canvas);
      onProgress(1, 1);
      return { blob, filename: `${base}.${extension}` };
    }

    const files: Zippable = {};
    const digits = String(pages.length).length;
    for (let n = 0; n < pages.length; n++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      drawPage(canvas, prepared, pages[n], scale);
      const image = await encode(canvas);
      // The image is already compressed; storing it again would only cost time.
      files[`${base}-${String(n + 1).padStart(digits, '0')}.${extension}`] = [new Uint8Array(await image.arrayBuffer()), { level: 0 }];
      onProgress(n + 1, pages.length);
      await nextFrame();
    }
    const zip = zipSync(files);
    return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), filename: `${base}-pages.zip` };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
    releaseLayers();
    releaseSketches();
  }
}
