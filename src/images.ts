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
}

const pictures = new Map<string, Picture>();

/** Decode and keep a picture. Replaces any picture already under that key. */
export async function addPicture(id: string, dataUrl: string): Promise<Picture> {
  const image = new Image();
  image.decoding = 'sync';
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`Could not read the picture ${id}`));
  });
  image.src = dataUrl;
  await loaded;
  const picture: Picture = { id, image, width: image.naturalWidth, height: image.naturalHeight };
  pictures.set(id, picture);
  return picture;
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
  return addPicture(id, dataUrl);
}

export function getPicture(id: string): Picture | undefined {
  return pictures.get(id);
}

/** Natural size of a picture, for the layout to shape the gap it leaves. */
export function pictureSize(id: string): { width: number; height: number } | null {
  const picture = pictures.get(id);
  return picture ? { width: picture.width, height: picture.height } : null;
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

/** Which of these keys have a picture behind them. */
export function knownPictures(ids: Iterable<string>): string[] {
  return [...ids].filter((id) => pictures.has(id));
}
