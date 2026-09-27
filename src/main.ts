import './ui/style.css';
import {
  DEFAULT_SETTINGS,
  PAPER_SIZES,
  PAPER_TEMPLATES,
  SAMPLE_TEXT,
  applyTemplate,
  withDefaults,
  type Settings,
} from './engine';
import { BYTES_PER_PIXEL, downloadBlob, safeFilename, type ExportJob } from './export/download';
import { addCustomFont, allFonts, loadFontCss, type FontEntry } from './fonts';
import { detectKind, importDocument, type PdfOptions } from './import';
import { reflowHardWraps } from './import/shared';
import { drawPage, drawPaperOnly, prepare, type Prepared } from './pipeline';
import { PRESETS, applyPreset } from './ui/presets';

const STORAGE_KEY = 'handscript.settings.v2';
const IMPORT_KEY = 'handscript.import.v1';

/** Settings that only change how a page is painted, not where the letters go. */
const PAINT_ONLY = new Set(['inkColor', 'paperColor', 'ruleColor', 'marginColor', 'texture', 'finish', 'inkWeight']);

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

const settings: Settings = loadSettings();
const importOptions: PdfOptions = loadImportOptions();
let prepared: Prepared | null = null;
let pageIndex = 0;
let layoutRun = 0;
let exporting = false;
let exportAbort: AbortController | null = null;

const preview = $<HTMLCanvasElement>('#preview');
const stageScroll = $<HTMLDivElement>('#stage-scroll');
const thumbsBox = $<HTMLDivElement>('#thumbs');
const statusEl = $<HTMLSpanElement>('#status');
const pageLabel = $<HTMLSpanElement>('#page-label');
const charCount = $<HTMLSpanElement>('#char-count');
const zoomSelect = $<HTMLSelectElement>('#zoom');
const toastEl = $<HTMLDivElement>('#toast');

// ---------------------------------------------------------------- settings io

function loadSettings(): Settings {
  const fromHash = readHash();
  if (fromHash) return fromHash;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return withDefaults(JSON.parse(raw));
  } catch {
    // Storage blocked or corrupt: fall back to defaults.
  }
  return structuredClone(DEFAULT_SETTINGS);
}

function loadImportOptions(): PdfOptions {
  const base: PdfOptions = { keepPageBreaks: false, detectHeadings: true, dropRunningHeads: true };
  try {
    const raw = localStorage.getItem(IMPORT_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<PdfOptions>;
      for (const key of Object.keys(base) as (keyof PdfOptions)[]) {
        if (typeof saved[key] === 'boolean') base[key] = saved[key] as boolean;
      }
    }
  } catch {
    // Not important enough to report.
  }
  return base;
}

let saveTimer = 0;
function saveSettings(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      localStorage.setItem(IMPORT_KEY, JSON.stringify(importOptions));
    } catch {
      // A very long document can exceed the quota: keep the style, drop the text.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, text: '' }));
      } catch {
        // Storage is unavailable. Nothing to do.
      }
    }
  }, 400);
}

/** Everything except the text, so a style can travel in a link. */
function styleOnly(): Partial<Settings> {
  const { text: _text, ...rest } = settings;
  return rest;
}

function readHash(): Settings | null {
  const match = /[#&]s=([^&]+)/.exec(location.hash);
  if (!match) return null;
  try {
    const json = decodeURIComponent(escape(atob(match[1].replace(/-/g, '+').replace(/_/g, '/'))));
    const parsed = withDefaults(JSON.parse(json));
    // A link carries a style, never someone else's text.
    parsed.text = SAMPLE_TEXT;
    return parsed;
  } catch {
    return null;
  }
}

function styleLink(): string {
  const json = JSON.stringify(styleOnly());
  const base64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_');
  return `${location.origin}${location.pathname}#s=${base64}`;
}

function getPath(path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown>)?.[key], settings);
}

function setPath(path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>(
    (obj, key) => obj[key] as Record<string, unknown>,
    settings as unknown as Record<string, unknown>,
  );
  target[last] = value;
}

// ------------------------------------------------------------------- feedback

let toastTimer = 0;
function toast(message: string, bad = false): void {
  toastEl.textContent = message;
  toastEl.classList.toggle('bad', bad);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), bad ? 9000 : 5000);
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ------------------------------------------------------------------- controls

function populateSelects(): void {
  const sizeSelect = $<HTMLSelectElement>('#paper-size');
  if (!sizeSelect.options.length) for (const p of PAPER_SIZES) sizeSelect.append(new Option(p.label, p.id));
}

const formatters: Record<string, (v: number) => string> = {
  pct: (v) => `${Math.round(v * 100)}%`,
  'signed-pct': (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`,
  deg: (v) => `${v > 0 ? '+' : ''}${v}°`,
  mm: (v) => (v === 0 ? 'off' : `${v} mm`),
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
  for (const group of document.querySelectorAll<HTMLElement>('[data-segmented]')) {
    const current = String(getPath(group.dataset.segmented!));
    for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.value === current));
    }
  }
  for (const tile of document.querySelectorAll<HTMLButtonElement>('#templates .tile')) {
    tile.setAttribute('aria-pressed', String(tile.dataset.template === settings.template));
  }
  for (const tile of document.querySelectorAll<HTMLButtonElement>('#fonts .tile')) {
    tile.setAttribute('aria-pressed', String(tile.dataset.font === settings.fontId));
  }
  $<HTMLInputElement>('#opt-page-breaks').checked = importOptions.keepPageBreaks;
  $<HTMLInputElement>('#opt-headings').checked = importOptions.detectHeadings;
  $<HTMLInputElement>('#opt-heads').checked = importOptions.dropRunningHeads;
  $<HTMLParagraphElement>('#seed-note').textContent = `Variation #${settings.seed}. The same settings and seed always give the same page.`;
  updateCharCount();
  updateEstimate();
}

function updateCharCount(): void {
  const chars = settings.text.length;
  const words = settings.text.trim() === '' ? 0 : settings.text.trim().split(/\s+/).length;
  charCount.textContent = `${chars.toLocaleString()} characters · ${words.toLocaleString()} words`;
}

function readControl(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): unknown {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.type === 'number') {
      const n = parseFloat(el.value);
      return Number.isFinite(n) ? n : getPath(el.dataset.key!);
    }
  }
  if (el instanceof HTMLSelectElement && el.dataset.number !== undefined) return Number(el.value);
  return el.value;
}

function onSettingChanged(key: string): void {
  saveSettings();
  syncControls();
  if (PAINT_ONLY.has(key) && prepared) {
    prepared = { ...prepared, settings: structuredClone(settings) };
    renderPreview();
    renderThumbs();
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
      if (key.startsWith('features.') || key.startsWith('margins.') || key === 'paperStyle' || key === 'lineSpacing') {
        settings.template = 'custom';
      }
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

  for (const group of document.querySelectorAll<HTMLElement>('[data-segmented]')) {
    const key = group.dataset.segmented!;
    for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('click', () => {
        setPath(key, button.dataset.value);
        onSettingChanged(key);
      });
    }
  }

  buildTabs();
  buildPresets();
  buildTemplates();
  buildFonts();

  $<HTMLButtonElement>('#reseed').addEventListener('click', () => {
    settings.seed = (Math.random() * 2 ** 31) | 0;
    onSettingChanged('seed');
  });

  $<HTMLButtonElement>('#reflow-text').addEventListener('click', () => {
    const joined = reflowHardWraps(settings.text);
    if (joined === settings.text) {
      toast('These lines are not hard-wrapped, so nothing needed joining.');
      return;
    }
    settings.text = joined;
    onSettingChanged('text');
    toast('Joined the wrapped lines back into paragraphs.');
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

  $<HTMLButtonElement>('#reset-all').addEventListener('click', () => {
    const keep = settings.text;
    Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
    settings.text = keep;
    history.replaceState(null, '', location.pathname);
    onSettingChanged('reset');
    toast('Back to the default settings. Your text was kept.');
  });

  $<HTMLButtonElement>('#copy-style').addEventListener('click', async () => {
    const link = styleLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copied. It carries the style, not your text.');
    } catch {
      history.replaceState(null, '', link);
      toast('Copying was blocked, so the link is in the address bar instead.');
    }
  });

  for (const [id, key] of [
    ['#opt-page-breaks', 'keepPageBreaks'],
    ['#opt-headings', 'detectHeadings'],
    ['#opt-heads', 'dropRunningHeads'],
  ] as [string, keyof PdfOptions][]) {
    $<HTMLInputElement>(id).addEventListener('change', (e) => {
      importOptions[key] = (e.target as HTMLInputElement).checked;
      saveSettings();
    });
  }

  for (const id of ['#import-file', '#import-text']) {
    $<HTMLInputElement>(id).addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) await runImport(file);
    });
  }

  $<HTMLInputElement>('#font-upload').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const entry = await addCustomFont(file);
      buildFonts();
      settings.fontId = entry.id;
      onSettingChanged('fontId');
      toast(`“${entry.label}” is ready to write with.`);
    } catch {
      toast(`Couldn't read “${file.name}”. Use a .ttf, .otf, .woff or .woff2 font file.`, true);
    }
  });

  $<HTMLButtonElement>('#prev-page').addEventListener('click', () => goToPage(pageIndex - 1));
  $<HTMLButtonElement>('#next-page').addEventListener('click', () => goToPage(pageIndex + 1));
  zoomSelect.addEventListener('change', renderPreview);

  $<HTMLSelectElement>('#page-range').addEventListener('change', (e) => {
    $<HTMLLabelElement>('#range-field').hidden = (e.target as HTMLSelectElement).value !== 'custom';
    updateEstimate();
  });
  $<HTMLInputElement>('#range-text').addEventListener('input', updateEstimate);
  $<HTMLSelectElement>('#dpi').addEventListener('change', updateEstimate);
  $<HTMLInputElement>('#lossless').addEventListener('change', updateEstimate);

  $<HTMLButtonElement>('#export-pdf').addEventListener('click', () => runExport('pdf'));
  $<HTMLButtonElement>('#export-png').addEventListener('click', () => runExport('png'));
  $<HTMLButtonElement>('#cancel-export').addEventListener('click', () => exportAbort?.abort());

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderPreview, 80);
  }).observe(stageScroll);

  bindKeyboard();
  bindDragAndDrop();
}

function buildTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const select = (tab: HTMLButtonElement) => {
    for (const other of tabs) {
      const chosen = other === tab;
      other.setAttribute('aria-selected', String(chosen));
      $<HTMLElement>(`#${other.getAttribute('aria-controls')!}`).hidden = !chosen;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      const next = tabs[(i + step + tabs.length) % tabs.length];
      next.focus();
      select(next);
    });
  });
}

function buildPresets(): void {
  const box = $<HTMLDivElement>('#presets');
  box.replaceChildren();
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
    const name = document.createElement('span');
    name.textContent = preset.label;
    const note = document.createElement('small');
    note.textContent = preset.note;
    button.append(name, note);
    button.addEventListener('click', () => {
      applyPreset(settings, preset);
      onSettingChanged('preset');
      toast(`${preset.label}: ${preset.note.toLowerCase()}.`);
    });
    box.append(button);
  }
}

/** The paper gallery shows a real render of each template, not a drawing of one. */
function buildTemplates(): void {
  const box = $<HTMLDivElement>('#templates');
  box.replaceChildren();
  let group = '';
  for (const template of PAPER_TEMPLATES) {
    if (template.group !== group) {
      group = template.group;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = group;
      box.append(label);
    }
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.template = template.id;
    tile.title = `${template.label}: ${template.note}`;
    const canvas = document.createElement('canvas');
    const name = document.createElement('b');
    name.textContent = template.label;
    const note = document.createElement('small');
    note.textContent = template.note;
    tile.append(canvas, name, note);
    tile.addEventListener('click', () => {
      applyTemplate(settings, template.id);
      onSettingChanged('template');
    });
    box.append(tile);
    // Draw the sheet itself, in the same engine that draws the page.
    const sample = applyTemplate(structuredClone(settings), template.id);
    // Drawn at twice the size it is shown at, so hairline rules survive.
    drawPaperOnly(canvas, sample, 168);
    canvas.style.setProperty('--ratio', `${canvas.width} / ${canvas.height}`);
  }
}

let fontObserver: IntersectionObserver | null = null;

function buildFonts(): void {
  const box = $<HTMLDivElement>('#fonts');
  box.replaceChildren();
  // Each hand's @font-face rules are fetched when its tile is first seen, so
  // opening the app costs one font, not twenty.
  fontObserver?.disconnect();
  fontObserver = new IntersectionObserver(
    (entries) => {
      const families = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.family ?? '');
      if (families.length === 0) return;
      for (const entry of entries) if (entry.isIntersecting) fontObserver?.unobserve(entry.target);
      void loadFontCss(families);
    },
    { root: box, rootMargin: '120px' },
  );
  const fonts = allFonts();
  let group = '';
  for (const font of fonts) {
    if (font.group !== group) {
      group = font.group;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.textContent = group;
      box.append(label);
    }
    const tile = fontTile(font);
    box.append(tile);
    if (!font.custom) fontObserver.observe(tile);
  }
  $<HTMLSpanElement>('#font-count').textContent = `${fonts.length} hands`;
}

function fontTile(font: FontEntry): HTMLButtonElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.dataset.font = font.id;
  tile.dataset.family = font.family;
  tile.title = `${font.label}: ${font.note}`;
  const sample = document.createElement('div');
  sample.className = 'sample';
  sample.style.fontFamily = `"${font.family}", cursive`;
  sample.textContent = font.label;
  const note = document.createElement('small');
  note.textContent = font.note;
  tile.append(sample, note);
  tile.addEventListener('click', () => {
    settings.fontId = font.id;
    onSettingChanged('fontId');
  });
  return tile;
}

function bindKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target?.isContentEditable === true;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'j') {
      goToPage(pageIndex + 1);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') {
      goToPage(pageIndex - 1);
      e.preventDefault();
    } else if (e.key === 'Home') {
      goToPage(0);
      e.preventDefault();
    } else if (e.key === 'End' && prepared) {
      goToPage(prepared.doc.pages.length - 1);
      e.preventDefault();
    }
  });
}

function bindDragAndDrop(): void {
  const overlay = $<HTMLDivElement>('#drop-overlay');
  let depth = 0;
  const show = (on: boolean) => (overlay.hidden = !on);
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    show(true);
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    show(false);
    const file = e.dataTransfer.files[0];
    if (/\.(ttf|otf|woff2?)$/i.test(file.name)) {
      try {
        const entry = await addCustomFont(file);
        buildFonts();
        settings.fontId = entry.id;
        onSettingChanged('fontId');
        toast(`“${entry.label}” is ready to write with.`);
      } catch {
        toast(`Couldn't read the font “${file.name}”.`, true);
      }
      return;
    }
    await runImport(file);
  });
}

// -------------------------------------------------------------------- preview

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
    renderThumbs();
    updateEstimate();
    if (result.doc.truncated > 0) {
      toast(`The document is longer than ${result.doc.pages.length} pages, so the end was left off.`, true);
    }
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
    markThumb();
    stageScroll.scrollTop = 0;
  }
}

function renderPreview(): void {
  if (!prepared) return;
  const { pages } = prepared.doc;
  const geometry = prepared.doc.geometryOf(pageIndex);
  const dpr = window.devicePixelRatio || 1;
  let cssWidth: number;
  if (zoomSelect.value === 'fit') {
    const style = getComputedStyle(stageScroll);
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const room = stageScroll.clientWidth - pad;
    const byHeight = ((stageScroll.clientHeight - pad) * geometry.width) / geometry.height;
    cssWidth = Math.max(160, Math.min(room, byHeight, geometry.width * 1.3));
  } else {
    cssWidth = geometry.width * parseFloat(zoomSelect.value);
  }
  const scale = Math.min((cssWidth * dpr) / geometry.width, 4);
  drawPage(preview, prepared, pageIndex, scale);
  preview.style.width = `${Math.round(cssWidth)}px`;
  preview.style.height = `${Math.round((cssWidth * geometry.height) / geometry.width)}px`;

  pageLabel.textContent = `Page ${pageIndex + 1} of ${pages.length}`;
  $<HTMLButtonElement>('#prev-page').disabled = pageIndex === 0;
  $<HTMLButtonElement>('#next-page').disabled = pageIndex >= pages.length - 1;
  preview.setAttribute('aria-label', `Handwritten preview, page ${pageIndex + 1} of ${pages.length}`);
  const sheets = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;
  setStatus(prepared.doc.truncated > 0 ? `${sheets} (the rest was left off)` : sheets);
}

/**
 * The page rail. Thumbnails are painted only when they scroll into view, so a
 * 300-page document costs no more to open than a one-page one.
 */
let thumbObserver: IntersectionObserver | null = null;
function renderThumbs(): void {
  if (!prepared) return;
  const pages = prepared.doc.pages.length;
  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const button = entry.target as HTMLButtonElement;
        paintThumb(button);
        thumbObserver?.unobserve(button);
      }
    },
    { root: thumbsBox, rootMargin: '200px' },
  );

  thumbsBox.replaceChildren();
  if (pages < 2) return;
  for (let i = 0; i < pages; i++) {
    const geometry = prepared.doc.geometryOf(i);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'thumb';
    button.dataset.page = String(i);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-label', `Page ${i + 1}`);
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = Math.round((88 * geometry.height) / geometry.width);
    const number = document.createElement('span');
    number.textContent = String(i + 1);
    button.append(canvas, number);
    button.addEventListener('click', () => goToPage(i));
    thumbsBox.append(button);
    thumbObserver.observe(button);
  }
  markThumb();
}

function paintThumb(button: HTMLButtonElement): void {
  if (!prepared || button.dataset.painted === '1') return;
  const canvas = button.querySelector('canvas');
  if (!canvas) return;
  const index = Number(button.dataset.page);
  const geometry = prepared.doc.geometryOf(index);
  drawPage(canvas, prepared, index, canvas.width / geometry.width);
  button.dataset.painted = '1';
}

function markThumb(): void {
  for (const button of thumbsBox.querySelectorAll<HTMLButtonElement>('.thumb')) {
    const chosen = Number(button.dataset.page) === pageIndex;
    button.setAttribute('aria-selected', String(chosen));
    if (chosen) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

// --------------------------------------------------------------------- import

let importing = false;
async function runImport(file: File): Promise<void> {
  if (importing) return;
  importing = true;
  const note = $<HTMLParagraphElement>('#import-note');
  note.hidden = false;
  note.textContent = `Reading ${file.name}…`;
  setStatus(`Reading ${file.name}…`);
  const kind = detectKind(file);
  try {
    const result = await importDocument(
      file,
      (done, total) => {
        const label = kind === 'pdf' ? `Reading page ${done} of ${total}…` : `Reading ${file.name}…`;
        note.textContent = label;
        setStatus(label);
      },
      { pdf: importOptions },
    );
    if (result.text.trim() === '') {
      note.textContent = result.warnings[0] ?? `${file.name} holds no text that can be read.`;
      toast(result.warnings[0] ?? `${file.name} holds no text that can be read.`, true);
      return;
    }
    settings.text = result.text;
    exportTitle = safeFilename(file.name);
    const words = result.text.trim().split(/\s+/).length;
    const from = result.pageCount > 0 ? ` from ${result.pageCount} ${result.pageCount === 1 ? 'page' : 'pages'}` : '';
    note.textContent = [`Read ${words.toLocaleString()} words${from} of ${file.name}.`, ...result.warnings].join(' ');
    onSettingChanged('text');
    toast(`Read ${words.toLocaleString()} words${from}. Writing it out now.`);
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : `Could not read ${file.name}.`;
    note.textContent = message;
    toast(message, true);
    setStatus('');
  } finally {
    importing = false;
  }
}

// --------------------------------------------------------------------- export

let exportTitle = 'handwriting';

/** Page indices chosen in the Save tab. */
function chosenPages(): number[] {
  const total = prepared?.doc.pages.length ?? 1;
  const all = Array.from({ length: total }, (_, i) => i);
  const mode = $<HTMLSelectElement>('#page-range').value;
  if (mode === 'current') return [pageIndex];
  if (mode !== 'custom') return all;
  const text = $<HTMLInputElement>('#range-text').value;
  const picked = new Set<number>();
  for (const part of text.split(',')) {
    const range = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    if (!range) continue;
    const from = Math.max(1, Number(range[1]));
    const to = Math.min(total, Number(range[2] ?? range[1]));
    for (let i = from; i <= to; i++) picked.add(i - 1);
  }
  return picked.size > 0 ? [...picked].sort((a, b) => a - b) : all;
}

function updateEstimate(): void {
  const el = document.querySelector<HTMLParagraphElement>('#export-estimate');
  if (!el || !prepared) return;
  const pages = chosenPages();
  const dpi = parseInt($<HTMLSelectElement>('#dpi').value, 10);
  const lossless = $<HTMLInputElement>('#lossless').checked;
  const geom = prepared.doc.geometry;
  const px = ((geom.width * dpi) / 96) * ((geom.height * dpi) / 96);
  const bytes = px * pages.length * (lossless ? BYTES_PER_PIXEL.png : BYTES_PER_PIXEL.jpeg);
  const mb = bytes / 1024 / 1024;
  const size = mb < 1 ? `${Math.max(1, Math.round(mb * 1024))} KB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const shape = `${Math.round((geom.width * dpi) / 96)} × ${Math.round((geom.height * dpi) / 96)} px`;
  el.textContent = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} at ${shape}, roughly ${size}.`;
}

async function runExport(kind: 'pdf' | 'png'): Promise<void> {
  if (exporting) return;
  exporting = true;
  exportAbort = new AbortController();
  const buttons = [$<HTMLButtonElement>('#export-pdf'), $<HTMLButtonElement>('#export-png')];
  const progress = $<HTMLProgressElement>('#export-progress');
  const status = $<HTMLParagraphElement>('#export-status');
  const cancel = $<HTMLButtonElement>('#cancel-export');
  buttons.forEach((b) => (b.disabled = true));
  cancel.hidden = false;
  progress.hidden = false;
  progress.value = 0;
  status.textContent = 'Preparing…';

  try {
    // Lay out from the live settings so the file matches what is on screen.
    clearTimeout(layoutTimer);
    const current = await prepare(structuredClone(settings));
    prepared = current;
    const dpi = parseInt($<HTMLSelectElement>('#dpi').value, 10);
    const lossless = $<HTMLInputElement>('#lossless').checked;
    const pages = chosenPages().filter((i) => i < current.doc.pages.length);
    const job: ExportJob = {
      prepared: current,
      dpi,
      pages,
      format: lossless ? 'png' : 'jpeg',
      title: exportTitle,
      signal: exportAbort.signal,
      onProgress: (done, total) => {
        progress.value = done / total;
        status.textContent = `Writing page ${done} of ${total}…`;
      },
    };
    // Exporters are loaded on first use; pdf-lib is most of the bundle.
    if (kind === 'pdf') {
      const { exportPdf } = await import('./export/pdf');
      downloadBlob(await exportPdf(job), `${exportTitle}.pdf`);
    } else {
      const { exportPng } = await import('./export/png');
      const { blob, filename } = await exportPng(job);
      downloadBlob(blob, filename);
    }
    status.textContent = `Done: ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} at ${dpi} DPI.`;
    toast(`Saved ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}.`);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      status.textContent = 'Cancelled.';
    } else {
      console.error(err);
      status.textContent =
        err instanceof RangeError
          ? 'The browser ran out of memory. Try a lower resolution or fewer pages at a time.'
          : 'Saving failed. Try a lower resolution or fewer pages at a time.';
      toast(status.textContent, true);
    }
  } finally {
    exporting = false;
    exportAbort = null;
    buttons.forEach((b) => (b.disabled = false));
    cancel.hidden = true;
    progress.hidden = true;
    renderPreview();
  }
}

// ----------------------------------------------------------------------- boot

populateSelects();
bindControls();
syncControls();
runLayout();
