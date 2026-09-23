import './ui/style.css';
import { DEFAULT_SETTINGS, PAPER_SIZES, SAMPLE_TEXT, withDefaults, type Settings } from './engine';
import { downloadBlob } from './export/download';
import { addCustomFont, allFonts } from './fonts';
import { drawPage, prepare, type Prepared } from './pipeline';
import { PRESETS } from './ui/presets';

const STORAGE_KEY = 'handscript.settings.v1';

/** Settings that only change how a page is painted, not where letters go. */
const PAINT_ONLY = new Set(['inkColor', 'paperColor', 'ruleColor', 'paperStyle', 'marginLine', 'texture', 'scanEffect']);

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

const settings: Settings = loadSettings();
let prepared: Prepared | null = null;
let pageIndex = 0;
let layoutRun = 0;
let exporting = false;

const preview = $<HTMLCanvasElement>('#preview');
const stageScroll = $<HTMLDivElement>('#stage-scroll');
const statusEl = $<HTMLSpanElement>('#status');
const pageLabel = $<HTMLSpanElement>('#page-label');
const charCount = $<HTMLSpanElement>('#char-count');
const zoomSelect = $<HTMLSelectElement>('#zoom');

// ---------------------------------------------------------------- settings

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return withDefaults(JSON.parse(raw));
  } catch {
    // Storage blocked or corrupt: fall back to defaults.
  }
  return structuredClone(DEFAULT_SETTINGS);
}

let saveTimer = 0;
function saveSettings(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Quota exceeded (very long text) or storage blocked: not fatal.
    }
  }, 400);
}

function getPath(path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown>)?.[key], settings);
}

function setPath(path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>((obj, key) => obj[key] as Record<string, unknown>, settings as unknown as Record<string, unknown>);
  target[last] = value;
}

// ---------------------------------------------------------------- controls

function populateSelects(): void {
  const fontSelect = $<HTMLSelectElement>('#font');
  fontSelect.replaceChildren();
  const fonts = allFonts();
  const custom = fonts.filter((f) => f.custom);
  const addOptions = (parent: HTMLElement, list: typeof fonts) => {
    for (const f of list) parent.append(new Option(f.label, f.id));
  };
  if (custom.length) {
    const group = document.createElement('optgroup');
    group.label = 'Your fonts';
    addOptions(group, custom);
    fontSelect.append(group);
    const builtIn = document.createElement('optgroup');
    builtIn.label = 'Built-in';
    addOptions(builtIn, fonts.filter((f) => !f.custom));
    fontSelect.append(builtIn);
  } else {
    addOptions(fontSelect, fonts);
  }
  if (!fonts.some((f) => f.id === settings.fontId)) settings.fontId = DEFAULT_SETTINGS.fontId;

  const sizeSelect = $<HTMLSelectElement>('#paper-size');
  if (!sizeSelect.options.length) for (const p of PAPER_SIZES) sizeSelect.append(new Option(p.label, p.id));
}

const formatters: Record<string, (v: number) => string> = {
  pct: (v) => `${Math.round(v * 100)}%`,
  'signed-pct': (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`,
  deg: (v) => `${v > 0 ? '+' : ''}${v}°`,
  mm: (v) => `${v} mm`,
  times: (v) => `${v.toFixed(2)}×`,
};

function syncControls(): void {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-key]')) {
    const value = getPath(el.dataset.key!);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
    else if (el.value !== String(value)) el.value = String(value);
  }
  for (const out of document.querySelectorAll<HTMLOutputElement>('output[data-for]')) {
    const value = Number(getPath(out.dataset.for!));
    out.value = (formatters[out.dataset.format ?? ''] ?? String)(value);
  }
  for (const group of document.querySelectorAll<HTMLElement>('[data-swatches]')) {
    const current = String(getPath(group.dataset.swatches!)).toLowerCase();
    for (const sw of group.querySelectorAll<HTMLButtonElement>('.swatch')) {
      sw.setAttribute('aria-pressed', String(sw.dataset.value!.toLowerCase() === current));
    }
  }
  updateCharCount();
}

function updateCharCount(): void {
  charCount.textContent = `${settings.text.length.toLocaleString()} characters`;
}

function readControl(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.type === 'number') {
      const n = parseFloat(el.value);
      return Number.isFinite(n) ? n : getPath(el.dataset.key!);
    }
  }
  return el.value;
}

function onSettingChanged(key: string): void {
  saveSettings();
  syncControls();
  if (PAINT_ONLY.has(key) && prepared) {
    prepared = { ...prepared, settings: { ...settings } };
    renderPreview();
  } else {
    // Very long documents take a moment to lay out; wait for a pause in typing.
    scheduleLayout(key === 'text' ? (settings.text.length > 200_000 ? 900 : 250) : 60);
  }
}

function bindControls(): void {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-key]')) {
    const key = el.dataset.key!;
    const event = el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === 'checkbox') ? 'change' : 'input';
    el.addEventListener(event, () => {
      setPath(key, readControl(el));
      onSettingChanged(key.split('.')[0]);
    });
  }

  for (const group of document.querySelectorAll<HTMLElement>('[data-swatches]')) {
    const key = group.dataset.swatches!;
    for (const sw of group.querySelectorAll<HTMLButtonElement>('.swatch')) {
      sw.style.setProperty('--c', sw.dataset.value!);
      sw.setAttribute('aria-label', sw.title);
      sw.addEventListener('click', () => {
        setPath(key, sw.dataset.value);
        onSettingChanged(key);
      });
    }
  }

  const presetBox = $<HTMLDivElement>('#presets');
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    button.innerHTML = `<span></span><small></small>`;
    button.querySelector('span')!.textContent = preset.label;
    button.querySelector('small')!.textContent = preset.note;
    button.addEventListener('click', () => {
      Object.assign(settings, structuredClone(preset.apply));
      onSettingChanged('preset');
    });
    presetBox.append(button);
  }

  $<HTMLButtonElement>('#reseed').addEventListener('click', () => {
    settings.seed = (Math.random() * 2 ** 31) | 0;
    onSettingChanged('seed');
  });

  $<HTMLButtonElement>('#sample-text').addEventListener('click', () => {
    settings.text = SAMPLE_TEXT;
    onSettingChanged('text');
  });

  $<HTMLButtonElement>('#clear-text').addEventListener('click', () => {
    settings.text = '';
    onSettingChanged('text');
    $<HTMLTextAreaElement>('#text').focus();
  });

  $<HTMLInputElement>('#import-text').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    settings.text = await file.text();
    onSettingChanged('text');
  });

  $<HTMLInputElement>('#font-upload').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const entry = await addCustomFont(file);
      populateSelects();
      settings.fontId = entry.id;
      onSettingChanged('fontId');
    } catch {
      setStatus(`Couldn't read "${file.name}". Use a .ttf, .otf, .woff or .woff2 font file.`);
    }
  });

  $<HTMLButtonElement>('#prev-page').addEventListener('click', () => goToPage(pageIndex - 1));
  $<HTMLButtonElement>('#next-page').addEventListener('click', () => goToPage(pageIndex + 1));
  zoomSelect.addEventListener('change', renderPreview);

  $<HTMLButtonElement>('#export-pdf').addEventListener('click', () => runExport('pdf'));
  $<HTMLButtonElement>('#export-png').addEventListener('click', () => runExport('png'));

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderPreview, 80);
  }).observe(stageScroll);
}

// ---------------------------------------------------------------- preview

function setStatus(text: string): void {
  statusEl.textContent = text;
}

let layoutTimer = 0;
function scheduleLayout(delay: number): void {
  clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(runLayout, delay);
}

async function runLayout(): Promise<void> {
  const run = ++layoutRun;
  const snapshot = structuredClone(settings);
  const slow = snapshot.text.length > 50_000;
  if (slow) {
    setStatus('Laying out pages…');
    // Let the status paint before the layout blocks the main thread.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    if (run !== layoutRun) return;
  }
  try {
    const result = await prepare(snapshot);
    if (run !== layoutRun) return; // a newer change is already on its way
    prepared = result;
    pageIndex = Math.min(pageIndex, result.doc.pages.length - 1);
    renderPreview();
  } catch (err) {
    console.error(err);
    setStatus('Something went wrong while laying out the page.');
  }
}

function goToPage(index: number): void {
  if (!prepared) return;
  const next = Math.max(0, Math.min(prepared.doc.pages.length - 1, index));
  if (next !== pageIndex) {
    pageIndex = next;
    renderPreview();
    stageScroll.scrollTop = 0;
  }
}

function renderPreview(): void {
  if (!prepared) return;
  const { geometry, pages } = prepared.doc;
  const dpr = window.devicePixelRatio || 1;
  let cssWidth: number;
  if (zoomSelect.value === 'fit') {
    const pad = parseFloat(getComputedStyle(stageScroll).paddingLeft) * 2;
    cssWidth = Math.max(160, Math.min(stageScroll.clientWidth - pad, geometry.width * 1.25));
  } else {
    cssWidth = geometry.width * parseFloat(zoomSelect.value);
  }
  const scale = Math.min((cssWidth * dpr) / geometry.width, 4);
  drawPage(preview, prepared, pageIndex, scale);
  preview.style.width = `${cssWidth}px`;
  preview.style.height = `${(cssWidth * geometry.height) / geometry.width}px`;

  pageLabel.textContent = `Page ${pageIndex + 1} of ${pages.length}`;
  $<HTMLButtonElement>('#prev-page').disabled = pageIndex === 0;
  $<HTMLButtonElement>('#next-page').disabled = pageIndex >= pages.length - 1;
  preview.setAttribute('aria-label', `Handwritten preview, page ${pageIndex + 1} of ${pages.length}`);
  setStatus(`${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
}

// ---------------------------------------------------------------- export

async function runExport(kind: 'pdf' | 'png'): Promise<void> {
  if (exporting) return;
  exporting = true;
  const buttons = [$<HTMLButtonElement>('#export-pdf'), $<HTMLButtonElement>('#export-png')];
  const progress = $<HTMLProgressElement>('#export-progress');
  const status = $<HTMLParagraphElement>('#export-status');
  buttons.forEach((b) => (b.disabled = true));
  progress.hidden = false;
  progress.value = 0;
  status.textContent = 'Preparing…';

  try {
    // Lay out from the live settings so the file matches what is on screen.
    clearTimeout(layoutTimer);
    const current = await prepare(structuredClone(settings));
    const dpi = parseInt($<HTMLSelectElement>('#dpi').value, 10);
    const onProgress = (done: number, total: number) => {
      progress.value = done / total;
      status.textContent = `Rendering page ${done} of ${total}…`;
    };
    // Exporters are loaded on first use; pdf-lib is most of the bundle.
    if (kind === 'pdf') {
      const { exportPdf } = await import('./export/pdf');
      downloadBlob(await exportPdf(current, dpi, onProgress), 'handwriting.pdf');
    } else {
      const { exportPng } = await import('./export/png');
      const { blob, filename } = await exportPng(current, dpi, onProgress);
      downloadBlob(blob, filename);
    }
    const pages = current.doc.pages.length;
    status.textContent = `Done: ${pages} ${pages === 1 ? 'page' : 'pages'} at ${dpi} DPI.`;
  } catch (err) {
    console.error(err);
    status.textContent =
      err instanceof RangeError
        ? 'The browser ran out of memory. Try a lower resolution or split the text.'
        : 'Export failed. Try a lower resolution.';
  } finally {
    exporting = false;
    buttons.forEach((b) => (b.disabled = false));
    progress.hidden = true;
  }
}

// ---------------------------------------------------------------- start

populateSelects();
bindControls();
syncControls();
runLayout();
