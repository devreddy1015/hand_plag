import { applyTemplate, type Settings } from '../engine';

export interface Preset {
  id: string;
  label: string;
  note: string;
  /** Paper template this look is written on. */
  template: string;
  /** Everything else: the hand, the pen, how carefully it is written. */
  apply: Partial<Settings>;
}

/**
 * One-click looks. A preset is a paper template plus a pen and a hand; it
 * never touches the text or the random seed, so pressing one is always safe.
 */
export const PRESETS: Preset[] = [
  {
    id: 'homework',
    label: 'School homework',
    note: 'Ruled book, blue ballpoint',
    template: 'notebook',
    apply: {
      fontId: 'caveat',
      pen: 'ballpoint',
      inkColor: '#1d3b8f',
      letterSize: 0.36,
      messiness: 0.5,
      corrections: 0.12,
      lineFill: 0.6,
      inkWeight: 1,
      finish: 'none',
    },
  },
  {
    id: 'neat-assignment',
    label: 'Neat assignment',
    note: 'Careful, even, well filled',
    template: 'notebook-double',
    apply: {
      fontId: 'kalam',
      pen: 'gel',
      inkColor: '#22336b',
      letterSize: 0.34,
      messiness: 0.32,
      corrections: 0.04,
      lineFill: 0.85,
      inkWeight: 1,
      finish: 'none',
    },
  },
  {
    id: 'lecture',
    label: 'Rushed lecture notes',
    note: 'Fast, messy, tiring hand',
    template: 'college',
    apply: {
      fontId: 'covered-by-your-grace',
      pen: 'ballpoint',
      inkColor: '#1f2024',
      letterSize: 0.38,
      messiness: 0.82,
      corrections: 0.4,
      lineFill: 0.45,
      slant: 6,
      inkWeight: 0.9,
      finish: 'none',
    },
  },
  {
    id: 'letter',
    label: 'Personal letter',
    note: 'Ivory paper, fountain pen',
    template: 'ivory',
    apply: {
      fontId: 'dawning-of-a-new-day',
      pen: 'fountain',
      inkColor: '#2a1f63',
      letterSize: 0.3,
      messiness: 0.45,
      corrections: 0.06,
      lineFill: 0.5,
      inkWeight: 1.15,
      finish: 'none',
    },
  },
  {
    id: 'legal',
    label: 'Legal pad memo',
    note: 'Yellow pad, black gel',
    template: 'legal-pad',
    apply: {
      fontId: 'shadows-into-light',
      pen: 'gel',
      inkColor: '#1f2024',
      letterSize: 0.4,
      messiness: 0.55,
      corrections: 0.15,
      lineFill: 0.65,
      finish: 'none',
    },
  },
  {
    id: 'pencil',
    label: 'Pencil on graph',
    note: 'Graph paper, soft pencil',
    template: 'graph',
    apply: {
      fontId: 'architects-daughter',
      pen: 'pencil',
      inkColor: '#4a4a4d',
      letterSize: 0.32,
      messiness: 0.5,
      corrections: 0.1,
      lineFill: 0.55,
      inkWeight: 1.2,
      finish: 'none',
    },
  },
  {
    id: 'exam',
    label: 'Exam answer',
    note: 'Printed sheet, tidy hand',
    template: 'exam',
    apply: {
      fontId: 'kalam',
      pen: 'ballpoint',
      inkColor: '#1b2a6b',
      letterSize: 0.33,
      messiness: 0.38,
      corrections: 0.08,
      lineFill: 0.8,
      finish: 'none',
    },
  },
  {
    id: 'scanned',
    label: 'Scanned homework',
    note: 'As it comes off a scanner',
    template: 'notebook',
    apply: {
      fontId: 'caveat',
      pen: 'ballpoint',
      inkColor: '#1d3b8f',
      letterSize: 0.36,
      messiness: 0.55,
      corrections: 0.15,
      lineFill: 0.6,
      finish: 'scan',
    },
  },
  {
    id: 'photo',
    label: 'Photo on a desk',
    note: 'Phone snap of the page',
    template: 'torn',
    apply: {
      fontId: 'caveat',
      pen: 'ballpoint',
      inkColor: '#242a3d',
      letterSize: 0.37,
      messiness: 0.6,
      corrections: 0.2,
      lineFill: 0.6,
      finish: 'photo',
    },
  },
  {
    id: 'cornell',
    label: 'Study notes',
    note: 'Cornell sheet, rollerball',
    template: 'cornell',
    apply: {
      fontId: 'patrick-hand',
      pen: 'rollerball',
      inkColor: '#1f3a5f',
      letterSize: 0.34,
      messiness: 0.45,
      corrections: 0.1,
      lineFill: 0.7,
      finish: 'none',
    },
  },
];

/** Apply a preset: its paper template first, then the hand and pen. */
export function applyPreset(settings: Settings, preset: Preset): void {
  applyTemplate(settings, preset.template);
  Object.assign(settings, structuredClone(preset.apply));
}
