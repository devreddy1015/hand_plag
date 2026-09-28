/**
 * Drawing a diagram of your own.
 *
 * Some figures are not in any document: a sketch of an apparatus, a quick
 * graph, an arrow between two ideas. They are drawn here, on a plain sheet,
 * and go into the page as pen strokes, so they are drawn back in the page's
 * own ink and pen like everything else.
 */
import type { Sketch } from '../engine';
import { simplify } from '../import/vectorize';
import { Pad } from './pad';

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

/** Height of the drawing sheet over its width. */
const SHEET = 0.62;

export interface DrawnSketch {
  sketch: Sketch;
  /** The drawing as a picture, for when diagrams are stuck on rather than drawn. */
  dataUrl: string;
  caption: string;
}

let pad: Pad | null = null;
let bound = false;
let resolveOpen: ((drawn: DrawnSketch | null) => void) | null = null;

/** Open the sheet. Resolves with the drawing, or null if it was closed without one. */
export function drawSketch(): Promise<DrawnSketch | null> {
  const dialog = $<HTMLDialogElement>('#sketch-dialog');
  bind();
  $<HTMLInputElement>('#sketch-caption').value = '';
  dialog.showModal();
  pad ??= new Pad($<HTMLCanvasElement>('#sketch-pad'), { cells: 1, cellAspect: SHEET, guides: false });
  pad.clear();
  return new Promise((resolve) => {
    resolveOpen = resolve;
  });
}

function bind(): void {
  if (bound) return;
  bound = true;
  const dialog = $<HTMLDialogElement>('#sketch-dialog');
  $<HTMLButtonElement>('#sketch-undo').addEventListener('click', () => pad?.undo());
  $<HTMLButtonElement>('#sketch-clear').addEventListener('click', () => pad?.clear());
  $<HTMLButtonElement>('#sketch-insert').addEventListener('click', () => {
    const drawn = pad && !pad.isEmpty() ? finish(pad.strokesOf(0), $<HTMLInputElement>('#sketch-caption').value.trim()) : null;
    resolveOpen?.(drawn);
    resolveOpen = null;
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    resolveOpen?.(null);
    resolveOpen = null;
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') {
      e.preventDefault();
      pad?.undo();
    }
  });
}

/** Crop the drawing to what was drawn and turn it into a sketch. */
function finish(strokes: number[][], caption: string): DrawnSketch | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.length; i += 3) {
      minX = Math.min(minX, s[i]);
      maxX = Math.max(maxX, s[i]);
      minY = Math.min(minY, s[i + 1]);
      maxY = Math.max(maxY, s[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const margin = 0.03;
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;
  const width = Math.max(0.05, maxX - minX);
  const height = Math.max(0.05, maxY - minY);
  const paths = strokes
    .filter((s) => s.length >= 3)
    .map((s) => {
      const pts: number[] = [];
      for (let i = 0; i < s.length; i += 3) pts.push((s[i] - minX) / width, (s[i + 1] - minY) / width);
      return { pts: pts.length > 4 ? simplify(pts, 0.0015, false) : pts, weight: 1 };
    });
  const sketch: Sketch = { aspect: width / height, paths, fills: [], labels: [], lineWidth: 0.004, handmade: true };

  // The same drawing as a picture, for pasting.
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = Math.max(1, Math.round(1200 / sketch.aspect));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1b1b1f';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of paths) {
    ctx.beginPath();
    ctx.moveTo(path.pts[0] * 1200, path.pts[1] * 1200);
    for (let k = 2; k < path.pts.length; k += 2) ctx.lineTo(path.pts[k] * 1200, path.pts[k + 1] * 1200);
    if (path.pts.length === 2) ctx.lineTo(path.pts[0] * 1200 + 0.1, path.pts[1] * 1200);
    ctx.stroke();
  }
  const dataUrl = canvas.toDataURL('image/png');
  canvas.width = 1;
  canvas.height = 1;
  return { sketch, dataUrl, caption };
}
