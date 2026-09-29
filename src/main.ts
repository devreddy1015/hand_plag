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
import { addCustomFont, allFonts, loadFontCss, setOwnHands, type FontEntry } from './fonts';
import { buildHand, loadHands, type BuiltHand } from './hands';
import { detectKind, importDocument, type PdfOptions } from './import';
import { addPicture, addPictureFile, addTracedPicture, clearPictures, pictureCount, restorePictures } from './images';
import { forgetPicturesExcept, pictureIdsIn } from './store';
import { openHandDialog } from './ui/hand-dialog';
import { drawSketch } from './ui/sketch-dialog';
import { reflowHardWraps } from './import/shared';
import { drawLookSample, drawPage, drawPaperOnly, prepare, type Prepared } from './pipeline';
import { MAIN_LOOKS, PRESETS, applyPreset, matchesPreset } from './ui/presets';

const STORAGE_KEY = 'handscript.settings.v2';
const ADVANCED_KEY = 'handscript.advanced.v1';
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
  return freshDefaults();
}

/**
 * The default settings with a hand of one's own. The random seed decides
 * every wobble on the page, so a fixed default would give everyone who types
 * the same words the very same page.
 */
function freshDefaults(): Settings {
  const fresh = structuredClone(DEFAULT_SETTINGS);
  fresh.seed = randomSeed();
  return fresh;
}

function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] >>> 1;
}

function loadImportOptions(): PdfOptions {
  const base: PdfOptions = { keepPageBreaks: false, detectHeadings: true, dropRunningHeads: true, diagrams: true };
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

/** Everything except the text and who wrote it, so a style can travel in a link. */
function styleOnly(): Partial<Settings> {
  const { text: _text, writerName: _name, writerId: _id, ...rest } = settings;
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
  neat: (v) => (v < 0.2 ? 'Very neat' : v < 0.42 ? 'Neat' : v < 0.62 ? 'Natural' : v < 0.82 ? 'Hurried' : 'Messy'),
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
  document.querySelectorAll<HTMLElement>('#own-hands .own-hand-row').forEach((row, i) => {
    row.setAttribute('aria-current', String(settings.fontId === `hand:${ownHands[i]?.id}`));
  });
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#easy-hands .chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.font === settings.fontId));
  }
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#easy-papers .chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.template === settings.template));
  }
  for (const card of document.querySelectorAll<HTMLButtonElement>('#easy-looks .look')) {
    const preset = PRESETS.find((p) => p.id === card.dataset.look);
    card.setAttribute('aria-pressed', String(preset !== undefined && matchesPreset(settings, preset)));
  }
  $<HTMLInputElement>('#opt-page-breaks').checked = importOptions.keepPageBreaks;
  $<HTMLInputElement>('#opt-headings').checked = importOptions.detectHeadings;
  $<HTMLInputElement>('#opt-heads').checked = importOptions.dropRunningHeads;
  $<HTMLInputElement>('#opt-diagrams').checked = importOptions.diagrams;
  $<HTMLSpanElement>('#diagram-count').textContent =
    pictureCount() === 0 ? 'none yet' : `${pictureCount()} in this document`;
  $<HTMLParagraphElement>('#seed-note').textContent = `Variation #${settings.seed}. The same settings and seed always give the same page.`;
  updateCharCount();
  updateEstimate();
}

function updateCharCount(): void {
  const chars = settings.text.length;
  const words = settings.text.trim() === '' ? 0 : settings.text.trim().split(/\s+/).length;
  charCount.textContent = `${chars.toLocaleString()} characters · ${words.toLocaleString()} words`;
  $<HTMLSpanElement>('#easy-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
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
  bindAdvanced();
  buildPresets();
  buildTemplates();
  buildFonts();
  buildEasy();

  const reseed = () => {
    settings.seed = randomSeed();
    onSettingChanged('seed');
  };
  $<HTMLButtonElement>('#reseed').addEventListener('click', reseed);
  $<HTMLButtonElement>('#reseed-stage').addEventListener('click', reseed);
  $<HTMLButtonElement>('#quick-pdf').addEventListener('click', () => runExport('pdf'));

  $<HTMLButtonElement>('#hand-new').addEventListener('click', () => openHand(null));
  // Carry on with the hand you have, or start one.
  $<HTMLButtonElement>('#easy-own').addEventListener('click', () => openHand(ownHands[0]?.id ?? null));
  const drawDiagram = async () => {
    const drawn = await drawSketch();
    if (!drawn) return;
    const id = `sketch-${Date.now().toString(36)}`;
    await addPicture(id, drawn.dataUrl, { sketch: drawn.sketch, kind: 'figure' });
    insertAtCursor(`\n![${drawn.caption.replace(/[[\]()]/g, ' ')}](${id})\n`);
    toast('Your diagram is on the page, drawn in the page’s own pen.');
  };
  $<HTMLButtonElement>('#draw-diagram').addEventListener('click', drawDiagram);
  $<HTMLButtonElement>('#easy-draw').addEventListener('click', drawDiagram);
  $<HTMLButtonElement>('#easy-pdf').addEventListener('click', () => runExport('pdf'));
  $<HTMLButtonElement>('#easy-png').addEventListener('click', () => runExport('png'));

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

  $<HTMLInputElement>('#diagram-upload').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await addDiagram(file);
  });

  $<HTMLButtonElement>('#sample-text').addEventListener('click', () => {
    settings.text = SAMPLE_TEXT;
    onSettingChanged('text');
  });

  for (const id of ['#clear-text', '#easy-clear']) {
    $<HTMLButtonElement>(id).addEventListener('click', () => {
      settings.text = '';
      onSettingChanged('text');
      textArea().focus();
    });
  }

  $<HTMLButtonElement>('#reset-all').addEventListener('click', () => {
    const keep = settings.text;
    Object.assign(settings, freshDefaults());
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
    ['#opt-diagrams', 'diagrams'],
  ] as [string, keyof PdfOptions][]) {
    $<HTMLInputElement>(id).addEventListener('change', (e) => {
      importOptions[key] = (e.target as HTMLInputElement).checked;
      saveSettings();
    });
  }

  for (const id of ['#import-file', '#import-text', '#easy-import']) {
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

/**
 * Most people want a hand, a sheet of paper and a PDF button. Everything else
 * is kept behind one switch rather than left on the page, so the app can be
 * used without reading it all first.
 */
function bindAdvanced(): void {
  const panel = $<HTMLElement>('.panel');
  const button = $<HTMLButtonElement>('#toggle-advanced');
  let shown = false;
  try {
    shown = localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    // Storage blocked: start simple.
  }
  const apply = () => {
    panel.classList.toggle('simple', !shown);
    button.setAttribute('aria-pressed', String(shown));
    button.textContent = shown ? 'Simple view' : 'More options';
    renderPreview();
  };
  button.addEventListener('click', () => {
    shown = !shown;
    try {
      localStorage.setItem(ADVANCED_KEY, shown ? '1' : '0');
    } catch {
      // Not worth reporting.
    }
    apply();
  });
  apply();
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

// ---------------------------------------------------------------- simple view

/** Hands offered in the simple view, most natural first. */
const EASY_HANDS = [
  'caveat',
  'kalam',
  'patrick-hand',
  'covered-by-your-grace',
  'reenie-beanie',
  'indie-flower',
  'shadows-into-light',
  'homemade-apple',
  'dawning-of-a-new-day',
];

/** Papers offered in the simple view, with names short enough for a chip. */
const EASY_PAPERS: [string, string][] = [
  ['notebook', 'Notebook'],
  ['college', 'College'],
  ['exam', 'Exam sheet'],
  ['plain', 'Plain'],
  ['graph', 'Graph'],
  ['legal-pad', 'Legal pad'],
];

const LOOK_TEXT = 'Monday, 12 March\n\nThe mitochondrion releases energy from glucose in small, controlled steps.';

/** Fill the simple view: the looks, the hands and the papers. */
function buildEasy(): void {
  const looks = $<HTMLDivElement>('#easy-looks');
  looks.replaceChildren();
  const pending: [HTMLCanvasElement, Settings][] = [];
  for (const preset of PRESETS.slice(0, MAIN_LOOKS)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'look';
    card.dataset.look = preset.id;
    const canvas = document.createElement('canvas');
    const name = document.createElement('span');
    name.textContent = preset.label;
    const note = document.createElement('small');
    note.textContent = preset.note;
    card.append(canvas, name, note);
    card.addEventListener('click', () => {
      applyPreset(settings, preset);
      onSettingChanged('preset');
    });
    looks.append(card);
    const sample = structuredClone(settings);
    applyPreset(sample, preset);
    pending.push([canvas, sample]);
  }
  // Each card is a real page in that look, drawn once the main page is up.
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const [canvas, sample] of pending) {
      try {
        await drawLookSample(canvas, sample, LOOK_TEXT, 170, 102);
      } catch (err) {
        console.warn('Could not draw a look', err);
      }
    }
  })();

  buildEasyHands();

  const papers = $<HTMLDivElement>('#easy-papers');
  papers.replaceChildren();
  for (const [id, short] of EASY_PAPERS) {
    const template = PAPER_TEMPLATES.find((t) => t.id === id);
    if (!template) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.template = id;
    chip.title = `${template.label}: ${template.note}`;
    const canvas = document.createElement('canvas');
    const name = document.createElement('small');
    name.textContent = short;
    chip.append(canvas, name);
    chip.addEventListener('click', () => {
      applyTemplate(settings, id);
      onSettingChanged('template');
    });
    papers.append(chip);
    drawPaperOnly(canvas, applyTemplate(structuredClone(settings), id), 128);
  }
}

/** The handwriting chips: your own hands first, then the bundled ones. */
function buildEasyHands(): void {
  const box = $<HTMLDivElement>('#easy-hands');
  box.replaceChildren();
  const fonts = allFonts();
  const offered = [...fonts.filter((f) => f.hand), ...EASY_HANDS.map((id) => fonts.find((f) => f.id === id)).filter((f): f is FontEntry => !!f)];
  void loadFontCss(offered.filter((f) => !f.hand).map((f) => f.family));
  for (const font of offered) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.font = font.id;
    chip.title = font.note;
    if (font.hand) {
      const canvas = document.createElement('canvas');
      drawHandSample(canvas, font.hand, sampleWords(font.hand));
      chip.append(canvas);
    } else {
      const face = document.createElement('span');
      face.className = 'face';
      face.style.fontFamily = `"${font.family}", cursive`;
      face.textContent = 'Hello';
      chip.append(face);
    }
    const name = document.createElement('small');
    name.textContent = font.label;
    chip.append(name);
    chip.addEventListener('click', () => {
      settings.fontId = font.id;
      onSettingChanged('fontId');
    });
    box.append(chip);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'chip';
  more.innerHTML = '<span class="face">…</span><small>More hands</small>';
  more.addEventListener('click', () => {
    $<HTMLButtonElement>('#toggle-advanced').click();
    $<HTMLButtonElement>('#tab-hand').click();
  });
  box.append(more);
}

/** The text box in view: the simple view's, or the Text tab's. */
function textArea(): HTMLTextAreaElement {
  return $<HTMLElement>('.panel').classList.contains('simple') ? $<HTMLTextAreaElement>('#easy-text') : $<HTMLTextAreaElement>('#text');
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

// ------------------------------------------------------------- your own hands

let ownHands: BuiltHand[] = [];

/** Read the hands written on this device, and offer them in the gallery. */
function refreshHands(): void {
  ownHands = loadHands().map(buildHand);
  setOwnHands(ownHands);
  renderOwnHands();
  if (document.querySelector('#easy-hands .chip')) buildEasyHands();
}

function openHand(id: string | null): void {
  openHandDialog(id, {
    saved: () => {
      refreshHands();
      buildFonts();
      if (settings.fontId.startsWith('hand:')) scheduleLayout(60);
    },
    use: (hand) => {
      refreshHands();
      buildFonts();
      settings.fontId = `hand:${hand.id}`;
      onSettingChanged('fontId');
      const built = ownHands.find((h) => h.id === hand.id);
      toast(
        built && built.written < 26
          ? `Writing in “${hand.name}”. Letters you haven't written yet are borrowed, so write more to make it all yours.`
          : `Writing in “${hand.name}”.`,
      );
    },
    toast,
  });
}

/** The hands you have written, each with a line in its own letters. */
function renderOwnHands(): void {
  const box = $<HTMLDivElement>('#own-hands');
  box.replaceChildren();
  for (const hand of ownHands) {
    const row = document.createElement('div');
    row.className = 'own-hand-row';
    row.setAttribute('aria-current', String(settings.fontId === `hand:${hand.id}`));
    const canvas = document.createElement('canvas');
    drawHandSample(canvas, hand, sampleWords(hand));
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = hand.name;
    const note = document.createElement('small');
    note.textContent = `${hand.written} ${hand.written === 1 ? 'character' : 'characters'} written`;
    who.append(name, note);
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'small';
    use.textContent = 'Use';
    use.addEventListener('click', () => {
      settings.fontId = `hand:${hand.id}`;
      onSettingChanged('fontId');
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'ghost small';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openHand(hand.id));
    row.append(canvas, who, use, edit);
    box.append(row);
  }
  $<HTMLButtonElement>('#hand-new').textContent = ownHands.length > 0 ? 'Write another hand' : 'Write your alphabet';
}

/** Something to show a hand with: a phrase if it has the letters, or the letters it has. */
function sampleWords(hand: BuiltHand): string {
  for (const phrase of ['hello there', 'handwriting', 'the notes', 'hello']) {
    if ([...phrase].every((ch) => ch === ' ' || hand.has(ch))) return phrase;
  }
  return [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].filter((ch) => hand.has(ch)).slice(0, 9).join('');
}

/** A few words in a hand of your own, drawn straight from its strokes. */
function drawHandSample(canvas: HTMLCanvasElement, hand: BuiltHand, text: string): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = 120;
  const cssH = 34;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const size = (cssH * 0.55) / Math.max(0.3, hand.capHeight);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = getComputedStyle(canvas.isConnected ? canvas : document.body).color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, size * hand.weight);
  let x = 4;
  const base = cssH * 0.72;
  for (const ch of text) {
    if (ch === ' ') {
      x += size * 0.3;
      continue;
    }
    const glyph = hand.glyph(ch, 0);
    if (!glyph) {
      x += size * 0.35;
      continue;
    }
    for (const stroke of glyph.strokes) {
      ctx.beginPath();
      for (let i = 0; i < stroke.length; i += 3) {
        const px = x + stroke[i] * size;
        const py = base + stroke[i + 1] * size;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    x += glyph.advance * size;
    if (x > cssW) break;
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
    if (!font.custom && !font.hand) fontObserver.observe(tile);
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
  if (font.hand) {
    const canvas = document.createElement('canvas');
    drawHandSample(canvas, font.hand, sampleWords(font.hand));
    sample.append(canvas);
  } else {
    sample.style.fontFamily = `"${font.family}", cursive`;
    sample.textContent = font.label;
  }
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
    if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) {
      await addDiagram(file);
      return;
    }
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

/** Put a picture into the document, where the writer is looking. */
async function addDiagram(file: File): Promise<void> {
  try {
    const picture = await addPictureFile(file);
    const caption = safeFilename(file.name, '').replace(/[[\]()]/g, ' ').trim();
    insertAtCursor(`\n![${caption}](${picture.id})\n`);
    toast('Diagram added. Drag another in, or write around it.');
  } catch {
    toast(`Couldn't read the picture “${file.name}”.`, true);
  }
}

/** Insert markup at the caret, or at the end when the writer is elsewhere. */
function insertAtCursor(markup: string): void {
  const area = textArea();
  const at = document.activeElement === area ? area.selectionStart : settings.text.length;
  const before = settings.text.slice(0, at).replace(/\n+$/, '');
  const after = settings.text.slice(at).replace(/^\n+/, '');
  settings.text = `${before}\n${markup.trim()}\n${after}`.replace(/\n{3,}/g, '\n\n');
  onSettingChanged('text');
  const caret = `${before}\n${markup.trim()}\n`.length;
  area.setSelectionRange(caret, caret);
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
  $<HTMLSpanElement>('#easy-pages').textContent = `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;
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
    clearPictures('pdf-');
    clearPictures('docx-');
    if (result.images) {
      await Promise.all(
        result.images.map((picture) =>
          // A PDF's figures come traced already; a Word file's are traced here.
          (picture.sketch || picture.kind === 'math' || picture.kind === 'photo'
            ? addPicture(picture.id, picture.dataUrl, {
                kind: picture.kind ?? 'figure',
                pointWidth: picture.pointWidth,
                sourceSize: picture.sourceSize,
                sketch: picture.sketch,
              })
            : addTracedPicture(picture.id, picture.dataUrl)
          ).catch(() => undefined),
        ),
      );
    }
    settings.text = result.text;
    void forgetPicturesExcept(pictureIdsIn(settings.text));
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
  const buttons = ['#export-pdf', '#export-png', '#easy-pdf', '#easy-png', '#quick-pdf'].map((id) => $<HTMLButtonElement>(id));
  // Progress shows in the Save tab and in the simple view alike.
  const bars = [$<HTMLProgressElement>('#export-progress'), $<HTMLProgressElement>('#easy-progress')];
  const statuses = [$<HTMLParagraphElement>('#export-status'), $<HTMLParagraphElement>('#easy-status')];
  const status = {
    set textContent(text: string) {
      for (const el of statuses) el.textContent = text;
    },
    get textContent(): string {
      return statuses[0].textContent ?? '';
    },
  };
  const progress = {
    set value(v: number) {
      for (const bar of bars) bar.value = v;
    },
    set hidden(on: boolean) {
      for (const bar of bars) bar.hidden = on;
    },
  };
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
refreshHands();
bindControls();
syncControls();
// The pictures a saved document refers to come back before its first page is drawn.
void restorePictures(pictureIdsIn(settings.text))
  .catch(() => 0)
  .then(() => {
    void forgetPicturesExcept(pictureIdsIn(settings.text));
    syncControls();
    return runLayout();
  });
