/**
 * Keeping a document's pictures between visits (browser only).
 *
 * The text and settings fit in local storage; a document's diagrams do not —
 * a page of cut-out figures is megabytes. They go in IndexedDB instead, keyed
 * by the id the text refers to them by, so reopening the app brings back the
 * same figures rather than empty boxes. Everything stays on this device.
 */
import type { Sketch } from './engine';

export interface StoredPicture {
  id: string;
  dataUrl: string;
  kind: 'figure' | 'math' | 'photo';
  pointWidth?: number;
  sourceSize?: number;
  sketch?: Sketch;
}

const DB_NAME = 'handscript';
const STORE = 'pictures';

let opening: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      // Private windows and locked-down browsers: work without it.
      resolve(null);
    }
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

export async function storePicture(picture: StoredPicture): Promise<void> {
  const database = await db();
  if (!database) return;
  try {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(picture);
    await done(tx);
  } catch {
    // Out of space, most likely. The picture still works for this session.
  }
}

/** The stored pictures among these ids. Missing ones are simply left out. */
export async function loadStoredPictures(ids: string[]): Promise<StoredPicture[]> {
  const database = await db();
  if (!database || ids.length === 0) return [];
  const out: StoredPicture[] = [];
  try {
    const tx = database.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    await Promise.all(
      ids.map(
        (id) =>
          new Promise<void>((resolve) => {
            const request = store.get(id);
            request.onsuccess = () => {
              if (request.result) out.push(request.result as StoredPicture);
              resolve();
            };
            request.onerror = () => resolve();
          }),
      ),
    );
  } catch {
    return out;
  }
  return out;
}

/** Forget every stored picture the current document no longer refers to. */
export async function forgetPicturesExcept(keep: Set<string>): Promise<void> {
  const database = await db();
  if (!database) return;
  try {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result) if (!keep.has(String(key))) store.delete(key);
    };
    await done(tx);
  } catch {
    // Housekeeping only.
  }
}

/** Ids of every picture a document's text refers to. */
export function pictureIdsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) ids.add(m[1]);
  return ids;
}
