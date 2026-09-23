import type { Settings } from '../engine';

export interface Preset {
  id: string;
  label: string;
  note: string;
  apply: Partial<Settings>;
}

/** One-click looks. They change style only, never the text or the random seed. */
export const PRESETS: Preset[] = [
  {
    id: 'notebook',
    label: 'School notebook',
    note: 'Ruled, blue ballpoint',
    apply: {
      fontId: 'caveat',
      pen: 'ballpoint',
      inkColor: '#1d3b8f',
      paperStyle: 'ruled',
      paperColor: '#fdfcf7',
      ruleColor: '#8fb1dc',
      marginLine: true,
      lineSpacing: 8,
      letterSize: 0.36,
      margins: { top: 20, right: 12, bottom: 12, left: 28 },
    },
  },
  {
    id: 'letter',
    label: 'Personal letter',
    note: 'Ivory, fountain pen',
    apply: {
      fontId: 'homemade-apple',
      pen: 'fountain',
      inkColor: '#2a1f63',
      paperStyle: 'plain',
      paperColor: '#f7efdc',
      marginLine: false,
      lineSpacing: 10,
      letterSize: 0.3,
      margins: { top: 24, right: 22, bottom: 20, left: 22 },
    },
  },
  {
    id: 'legal-pad',
    label: 'Legal pad',
    note: 'Yellow, black gel',
    apply: {
      fontId: 'shadows-into-light',
      pen: 'gel',
      inkColor: '#1f2024',
      paperStyle: 'ruled',
      paperColor: '#fbf2a9',
      ruleColor: '#7fa3c8',
      marginLine: true,
      lineSpacing: 8.5,
      letterSize: 0.4,
      margins: { top: 26, right: 10, bottom: 10, left: 32 },
    },
  },
  {
    id: 'graph',
    label: 'Graph paper',
    note: 'Grid, pencil',
    apply: {
      fontId: 'kalam',
      pen: 'pencil',
      inkColor: '#48484a',
      paperStyle: 'grid',
      paperColor: '#fbfbf8',
      ruleColor: '#9cc6ab',
      marginLine: false,
      lineSpacing: 10,
      letterSize: 0.34,
      margins: { top: 15, right: 12, bottom: 12, left: 15 },
    },
  },
];
