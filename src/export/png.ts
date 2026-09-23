import { zipSync, type Zippable } from 'fflate';
import { createCanvas, drawPage, type Prepared } from '../pipeline';
import { canvasToBlob, nextFrame, type Progress } from './download';

/** A PNG for a single page, or a ZIP of numbered PNGs for several. */
export async function exportPng(
  prepared: Prepared,
  dpi: number,
  onProgress: Progress,
  signal?: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  const { pages } = prepared.doc;
  const canvas = createCanvas(1, 1) as HTMLCanvasElement;
  const scale = dpi / 96;

  if (pages.length === 1) {
    drawPage(canvas, prepared, 0, scale);
    const blob = await canvasToBlob(canvas, 'image/png');
    onProgress(1, 1);
    return { blob, filename: 'handwriting.png' };
  }

  const files: Zippable = {};
  const digits = String(pages.length).length;
  for (let i = 0; i < pages.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    drawPage(canvas, prepared, i, scale);
    const png = await canvasToBlob(canvas, 'image/png');
    // PNG is already compressed; store without deflating again.
    files[`page-${String(i + 1).padStart(digits, '0')}.png`] = [new Uint8Array(await png.arrayBuffer()), { level: 0 }];
    onProgress(i + 1, pages.length);
    await nextFrame();
  }
  const zip = zipSync(files);
  return { blob: new Blob([zip as BlobPart], { type: 'application/zip' }), filename: 'handwriting-pages.zip' };
}
