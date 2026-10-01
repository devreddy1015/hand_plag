/**
 * The Android app's side of `#platform`. The website's is
 * `website/src/platform.ts`; this file has the same exports, and the app
 * build (vite.config.ts) puts it in that one's place.
 *
 * A WebView cannot download a file the way a browser does. So a finished
 * file is written to the phone's Documents/Handscript folder, where the Files
 * app and every upload dialog can find it, and the share sheet is opened on
 * it, so it can go straight to WhatsApp, Drive or Classroom.
 */
import { App } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type * as WebPlatform from '../../website/src/platform';

export const isApp: typeof WebPlatform.isApp = true;

const FOLDER = 'Handscript';
/** Bytes written per call to the native side. A multiple of 3, so each piece is whole base64. */
const CHUNK = 3 * 512 * 1024;

export const startPlatform: typeof WebPlatform.startPlatform = () => {
  // The back button closes an open dialog before it leaves a page or the app.
  void App.addListener('backButton', ({ canGoBack }) => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (dialog) dialog.close();
    else if (canGoBack) history.back();
    else void App.exitApp();
  });
  // The app has no second window to open a link in, so such links open in place.
  for (const link of document.querySelectorAll('a[target="_blank"]')) link.removeAttribute('target');
};

export const saveFile: typeof WebPlatform.saveFile = async (blob, filename) => {
  let where: string | null = `Documents/${FOLDER}`;
  let uri: string;
  try {
    uri = await write(blob, `${FOLDER}/${filename}`, Directory.Documents);
  } catch {
    // Android 10 and older ask before an app writes to Documents. Turned
    // down, the file stays in the app's own space and is shared from there.
    where = null;
    uri = await write(blob, filename, Directory.Cache);
  }
  // The file is saved already, so the editor is told now rather than when the
  // share sheet closes; closing it without choosing anything is no failure.
  Share.share({ title: filename, files: [uri], dialogTitle: 'Send or save' }).catch(() => undefined);
  return where;
};

/**
 * Write a file in pieces: a long document's PDF runs to tens of megabytes,
 * too much to hand across to the native side in one go.
 */
async function write(blob: Blob, path: string, directory: Directory): Promise<string> {
  const { uri } = await Filesystem.writeFile({ path, directory, data: await base64(blob.slice(0, CHUNK)), recursive: true });
  for (let start = CHUNK; start < blob.size; start += CHUNK) {
    await Filesystem.appendFile({ path, directory, data: await base64(blob.slice(start, start + CHUNK)) });
  }
  return uri;
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
