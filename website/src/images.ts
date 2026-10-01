/**
 * The pictures a document refers to.
 *
 * Diagrams arrive either cut out of an imported PDF or dropped in by hand, and
 * the text refers to them by key: `![caption](pdf-3-1)`. They live here for
 * the session, decoded and ready to draw. They are deliberately not saved with
 * the settings — a page of diagrams is megabytes, and browser storage is not
 * the place for it — so re-opening the app keeps the text and leaves a ruled
 * box where each figure was, which is exactly what a half-finished page looks
 * like anyway.
 */
export interface Picture {
  id: string;
  image: HTMLImageElement;
  width: number;
  height: number;
  /** An equation is drawn at the size of the writing around it; a photograph is never traced. */
  kind: 'figure' | 'math' | 'photo';
  /** Width on the source page in points, and the size of its running text. */
  pointWidth?: number;
  sourceSize?: number;
  /** The picture as lines and words, so it can be copied out by hand. */
  sketch?: Sketch;
}

import type { Sketch } from './engine';
import { looksLikeLineArt, luminance, vectorize } from './import/vectorize';
import { loadStoredPictures, storePicture } from './store';

const pictures = new Map<string, Picture>();

/** Longest side a dropped-in picture is traced at: detail enough, quick enough. */
const TRACE_PX = 1400;

/**
 * Decode and keep a picture. Replaces any picture already under that key, and
 * stores it so it is still there next visit (unless it came from the store).
 */
export async function addPicture(id: string, dataUrl: string, about: Partial<Picture> = {}, persist = true): Promise<Picture> {
  const image = new Image();
  image.decoding = 'sync';
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Could not read the picture ${id}`));
  });
  image.src = dataUrl;
  await loaded;
  const picture: Picture = {
    kind: 'figure',
    ...about,
    id,
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  pictures.set(id, picture);
  if (persist) {
    void storePicture({
      id,
      dataUrl,
      kind: picture.kind,
      pointWidth: picture.pointWidth,
      sourceSize: picture.sourceSize,
      sketch: picture.sketch,
    });
  }
  return picture;
}

/** Bring back the pictures a saved document refers to. */
export async function restorePictures(ids: Iterable<string>): Promise<number> {
  const wanted = [...ids].filter((id) => !pictures.has(id));
  const stored = await loadStoredPictures(wanted);
  await Promise.all(
    stored.map((p) =>
      addPicture(p.id, p.dataUrl, { kind: p.kind, pointWidth: p.pointWidth, sourceSize: p.sourceSize, sketch: p.sketch }, false).catch(
        () => undefined,
      ),
    ),
  );
  return stored.length;
}

/**
 * Keep a picture that came with a document but not with a tracing (a Word
 * file's pictures): trace it now, or mark it a photograph if it is not line art.
 */
export async function addTracedPicture(id: string, dataUrl: string): Promise<Picture> {
  const probe = await addPicture(id, dataUrl, {}, false);
  const sketch = traceImage(probe.image);
  return addPicture(id, dataUrl, sketch ? { sketch } : { kind: 'photo' });
}

/** Read a file the reader dropped in, and keep it under a fresh key. */
export async function addPictureFile(file: File): Promise<Picture> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
  const id = `drawn-${pictures.size + 1}-${Math.random().toString(36).slice(2, 7)}`;
  return addTracedPicture(id, dataUrl);
}

/**
 * Trace a picture into pen paths, so it can be copied out by hand. A
 * photograph, or anything too busy to be line art, gives null and is stuck
 * on the page as it is.
 */
export function traceImage(image: HTMLImageElement): Sketch | null {
  const nw = image.naturalWidth;
  const nh = image.naturalHeight;
  if (nw < 8 || nh < 8) return null;
  // Small pictures are traced larger, so a thin line is still a line to follow.
  const k = Math.min(TRACE_PX / Math.max(nw, nh), Math.max(1, 700 / Math.max(nw, nh)));
  const w = Math.max(8, Math.round(nw * k));
  const h = Math.max(8, Math.round(nh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const lum = luminance(data);
  canvas.width = 1;
  canvas.height = 1;
  if (!looksLikeLineArt(lum)) return null;
  const traced = vectorize(lum, w, h, null, {}, data);
  if (!traced || traced.paths.length + traced.fills.length === 0) return null;
  const s = 1 / w;
  return {
    aspect: w / h,
    paths: traced.paths.map((p) => ({ pts: p.pts.map((v) => v * s), weight: p.weight, closed: p.closed })),
    fills: traced.fills.map((f) => ({ pts: f.pts.map((v) => v * s), area: f.area * s * s, tone: f.tone, group: f.group })),
    labels: [],
    lineWidth: traced.lineWidth * s,
  };
}

/** Everything known about a picture, for the layout to shape its gap. */
export function pictureMetrics(id: string): Picture | null {
  return pictures.get(id) ?? null;
}

/** The drawable image for a placed diagram, or null if it is not to hand. */
export function pictureImage(id: string): CanvasImageSource | null {
  return pictures.get(id)?.image ?? null;
}

export function pictureCount(): number {
  return pictures.size;
}

/** Forget the pictures of a document that is no longer open. */
export function clearPictures(prefix?: string): void {
  if (prefix === undefined) {
    pictures.clear();
    return;
  }
  for (const id of [...pictures.keys()]) if (id.startsWith(prefix)) pictures.delete(id);
}
