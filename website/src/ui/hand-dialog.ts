/**
 * The page where you write your own alphabet.
 *
 * One character at a time, three times each, in three ruled boxes. Moving on
 * saves what was written, so a hand can be built up over several sittings and
 * used before it is finished: anything not yet written is borrowed from a
 * print hand, scaled to match.
 */
import { FONTS } from '../fonts';
import {
  HAND_CHARACTERS,
  SAMPLES_PER_CHARACTER,
  loadHands,
  newHand,
  parseHandFile,
  roundSample,
  saveHands,
  type OwnHand,
} from '../hands';
import { saveFile } from '#platform';
import { Pad, emToPad, padToEm, PAD_GUIDES } from './pad';

export interface HandDialogEvents {
  /** The hands changed on disk: rebuild the gallery. */
  saved(): void;
  /** Write with this hand now. */
  use(hand: OwnHand): void;
  /** Something worth telling the writer. */
  toast(message: string, bad?: boolean): void;
}

const GROUPS: [string, string][] = [
  ['Small letters', HAND_CHARACTERS.lower],
  ['Capitals', HAND_CHARACTERS.upper],
  ['Numbers', HAND_CHARACTERS.digits],
  ['Punctuation', HAND_CHARACTERS.marks],
];

const ORDER = GROUPS.flatMap(([, chars]) => [...chars]);

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
};

let pad: Pad | null = null;
let hand: OwnHand = newHand();
let index = 0;
let events: HandDialogEvents | null = null;
let bound = false;

/** Open the page for a hand: an existing one to carry on, or a new one. */
export function openHandDialog(handId: string | null, on: HandDialogEvents): void {
  events = on;
  const existing = handId ? loadHands().find((h) => h.id === handId) : undefined;
  hand = existing ? structuredClone(existing) : newHand(nextName());
  bind();
  const dialog = $<HTMLDialogElement>('#hand-dialog');
  $<HTMLInputElement>('#hand-name').value = hand.name;
  fillStandIns();
  $<HTMLButtonElement>('#hand-delete').hidden = !existing;
  // Start on the first character not yet written.
  const first = ORDER.findIndex((ch) => !(hand.samples[ch]?.length > 0));
  index = first === -1 ? 0 : first;
  dialog.showModal();
  pad ??= new Pad($<HTMLCanvasElement>('#hand-pad'), { cells: SAMPLES_PER_CHARACTER, cellAspect: 1.05, guides: true, onChange: () => updateButtons() });
  show(index);
}

function nextName(): string {
  const taken = new Set(loadHands().map((h) => h.name));
  if (!taken.has('My handwriting')) return 'My handwriting';
  for (let n = 2; ; n++) if (!taken.has(`My handwriting ${n}`)) return `My handwriting ${n}`;
}

function fillStandIns(): void {
  const select = $<HTMLSelectElement>('#hand-standin');
  if (select.options.length === 0) {
    for (const font of FONTS.filter((f) => f.group === 'Print')) select.append(new Option(font.label, font.family));
  }
  select.value = hand.standIn;
  if (select.value !== hand.standIn) select.value = 'Patrick Hand';
}

function bind(): void {
  if (bound) return;
  bound = true;
  const dialog = $<HTMLDialogElement>('#hand-dialog');
  $<HTMLButtonElement>('#hand-next').addEventListener('click', () => step(1));
  $<HTMLButtonElement>('#hand-prev').addEventListener('click', () => step(-1));
  $<HTMLButtonElement>('#hand-undo').addEventListener('click', () => pad?.undo());
  $<HTMLButtonElement>('#hand-clear').addEventListener('click', () => pad?.clear());
  $<HTMLInputElement>('#hand-name').addEventListener('change', (e) => {
    hand.name = (e.target as HTMLInputElement).value.trim().slice(0, 40) || 'My handwriting';
    persist();
  });
  $<HTMLSelectElement>('#hand-standin').addEventListener('change', (e) => {
    hand.standIn = (e.target as HTMLSelectElement).value;
    persist();
  });
  $<HTMLButtonElement>('#hand-use').addEventListener('click', () => {
    keep();
    persist();
    dialog.close();
    events?.use(hand);
  });
  $<HTMLButtonElement>('#hand-export').addEventListener('click', () => {
    keep();
    persist();
    const blob = new Blob([JSON.stringify(hand)], { type: 'application/json' });
    void saveFile(blob, `${hand.name.replace(/[^\w -]+/g, '').trim() || 'handwriting'}.hand.json`);
  });
  $<HTMLInputElement>('#hand-import').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const read = parseHandFile(await file.text());
    if (!read) {
      events?.toast(`“${file.name}” is not a handwriting file saved from here.`, true);
      return;
    }
    hand = read;
    $<HTMLInputElement>('#hand-name').value = hand.name;
    fillStandIns();
    persist();
    show(0);
    events?.toast(`Opened “${hand.name}”.`);
  });
  $<HTMLButtonElement>('#hand-delete').addEventListener('click', () => {
    const others = loadHands().filter((h) => h.id !== hand.id);
    saveHands(others);
    dialog.close();
    events?.saved();
    events?.toast(`Deleted “${hand.name}”.`);
  });
  dialog.addEventListener('close', () => {
    keep();
    if (Object.keys(hand.samples).length > 0) persist();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') {
      e.preventDefault();
      pad?.undo();
    }
  });
}

/** Take what is on the pad into the hand. */
function keep(): void {
  if (!pad) return;
  const ch = ORDER[index];
  const samples = [];
  for (let cell = 0; cell < SAMPLES_PER_CHARACTER; cell++) {
    if (pad.isEmpty(cell)) continue;
    samples.push(roundSample({ strokes: padToEm(pad.strokesOf(cell)) }));
  }
  if (samples.length > 0) hand.samples[ch] = samples;
  else delete hand.samples[ch];
}

function persist(): void {
  hand.updated = Date.now();
  const all = loadHands().filter((h) => h.id !== hand.id);
  if (!saveHands([hand, ...all])) events?.toast('This browser would not save the hand. Save it to a file to keep it.', true);
  events?.saved();
  $<HTMLButtonElement>('#hand-delete').hidden = false;
}

function step(by: number): void {
  if (by > 0 && index === ORDER.length - 1) {
    $<HTMLButtonElement>('#hand-use').click();
    return;
  }
  keep();
  persist();
  show(Math.max(0, Math.min(ORDER.length - 1, index + by)));
}

function show(i: number): void {
  index = i;
  const ch = ORDER[index];
  $<HTMLElement>('#hand-char').textContent = ch === ' ' ? 'space' : ch;
  const name = describe(ch);
  $<HTMLElement>('#hand-char-name').textContent = name ? `(${name})` : '';
  if (pad) {
    pad.clear();
    const samples = hand.samples[ch] ?? [];
    samples.slice(0, SAMPLES_PER_CHARACTER).forEach((sample, cell) => {
      // Put each copy back in the middle of its box.
      let min = Infinity;
      let max = -Infinity;
      for (const stroke of sample.strokes) for (let k = 0; k < stroke.length; k += 3) (min = Math.min(min, stroke[k])), (max = Math.max(max, stroke[k]));
      const cellWidth = 1 / 1.05;
      const offset = (cellWidth - (max - min) * PAD_GUIDES.em) / 2 - min * PAD_GUIDES.em;
      pad!.setStrokes(cell, emToPad(sample.strokes, offset));
    });
  }
  renderChars();
  updateButtons();
}

function describe(ch: string): string {
  const names: Record<string, string> = {
    '.': 'full stop',
    ',': 'comma',
    ';': 'semicolon',
    ':': 'colon',
    '!': 'exclamation mark',
    '?': 'question mark',
    "'": 'apostrophe',
    '"': 'quotation marks',
    '-': 'hyphen',
    '(': 'opening bracket',
    ')': 'closing bracket',
    '/': 'slash',
    '&': 'ampersand',
    '+': 'plus',
    '=': 'equals',
    '%': 'per cent',
  };
  if (names[ch]) return names[ch];
  if (/[a-z]/.test(ch)) return 'small letter';
  if (/[A-Z]/.test(ch)) return 'capital';
  return '';
}

function renderChars(): void {
  const box = $<HTMLDivElement>('#hand-chars');
  box.replaceChildren();
  for (const [label, chars] of GROUPS) {
    const head = document.createElement('div');
    head.className = 'group-label';
    head.textContent = label;
    box.append(head);
    for (const ch of chars) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'char';
      button.textContent = ch;
      const count = hand.samples[ch]?.length ?? 0;
      button.dataset.state = count >= SAMPLES_PER_CHARACTER ? 'done' : count > 0 ? 'part' : 'empty';
      button.setAttribute('aria-pressed', String(ORDER[index] === ch));
      button.setAttribute('aria-label', `${ch} ${describe(ch)}, ${count} of ${SAMPLES_PER_CHARACTER} written`);
      button.addEventListener('click', () => {
        keep();
        persist();
        show(ORDER.indexOf(ch));
      });
      box.append(button);
    }
  }
  const written = ORDER.filter((c) => (hand.samples[c]?.length ?? 0) > 0).length;
  const lower = [...HAND_CHARACTERS.lower].filter((c) => (hand.samples[c]?.length ?? 0) > 0).length;
  $<HTMLElement>('#hand-progress').textContent =
    lower < 26 ? `${written} of ${ORDER.length} written · ${lower} of 26 small letters` : `${written} of ${ORDER.length} written`;
  box.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
}

function updateButtons(): void {
  $<HTMLButtonElement>('#hand-prev').disabled = index === 0;
  $<HTMLButtonElement>('#hand-next').textContent = index === ORDER.length - 1 ? 'Done' : 'Next ›';
}
