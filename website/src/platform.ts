/**
 * The few things that differ between the website and the Android app.
 *
 * The editor imports this module as `#platform`. The website build gets this
 * file; the app build puts `app/src/platform.ts` in its place, which has the
 * same exports. Nothing else in the editor knows which one it is running in.
 */

/** True inside the Android app. */
export const isApp: boolean = false;

/** Anything the platform needs before the editor starts. The website needs nothing. */
export function startPlatform(): void {}

/**
 * Hand a finished file to the person: in a browser, a download. Returns where
 * the file went, when that is worth telling them, or null.
 */
export async function saveFile(blob: Blob, filename: string): Promise<string | null> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}
