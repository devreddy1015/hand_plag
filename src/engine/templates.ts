/**
 * Paper templates: the kinds of sheet people actually write on.
 *
 * A template only ever touches the paper (size, ruling, colours, margins and
 * printed furniture), never the handwriting — except where the ruling dictates
 * the letter size, as on four-line and Séyès practice paper, which is noted on
 * the template itself.
 */
import type { Margins, PaperFeatures, Settings } from './types';

export const DEFAULT_FEATURES: PaperFeatures = {
  marginRule: 'single',
  headerRule: true,
  nameDateLine: false,
  holes: 'none',
  mirrorEvenPages: false,
  pageNumber: 'none',
  cueColumn: 0,
  summaryBox: 0,
  columns: 1,
  columnGap: 8,
  columnDivider: false,
  showThrough: false,
  tornEdge: false,
};

export type PaperPatch = Partial<Omit<Settings, 'features' | 'margins'>> & {
  features?: Partial<PaperFeatures>;
  margins?: Partial<Margins>;
};

export interface PaperTemplate {
  id: string;
  label: string;
  /** One-line description shown under the thumbnail. */
  note: string;
  group: 'Notebook' | 'Practice' | 'Grid' | 'Office' | 'Plain' | 'Small';
  apply: PaperPatch;
}

const INK_BLUE_RULE = '#93b4dd';
const RED_MARGIN = '#d9634f';

export const PAPER_TEMPLATES: PaperTemplate[] = [
  {
    id: 'notebook',
    label: 'Exercise book',
    note: 'Ruled 8 mm, red margin',
    group: 'Notebook',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8,
      paperColor: '#fdfcf7',
      ruleColor: INK_BLUE_RULE,
      marginColor: RED_MARGIN,
      margins: { top: 20, right: 12, bottom: 14, left: 28 },
      features: { marginRule: 'single', headerRule: true },
    },
  },
  {
    id: 'notebook-double',
    label: 'School notebook',
    note: 'Double red margin, header',
    group: 'Notebook',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8.5,
      paperColor: '#fefdf9',
      ruleColor: '#9cb9de',
      marginColor: '#d4574a',
      margins: { top: 22, right: 12, bottom: 14, left: 30 },
      features: { marginRule: 'double', headerRule: true },
    },
  },
  {
    id: 'college',
    label: 'College ruled',
    note: '7.1 mm, three holes',
    group: 'Notebook',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 7.1,
      paperColor: '#fdfdfa',
      ruleColor: '#a7bfe0',
      marginColor: '#dd7a6b',
      margins: { top: 18, right: 10, bottom: 12, left: 32 },
      features: { marginRule: 'single', headerRule: false, holes: 'punch3' },
    },
  },
  {
    id: 'wide',
    label: 'Wide ruled',
    note: '8.7 mm, two holes',
    group: 'Notebook',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8.7,
      paperColor: '#fdfdfa',
      ruleColor: '#a7bfe0',
      marginColor: '#dd7a6b',
      margins: { top: 20, right: 10, bottom: 12, left: 30 },
      features: { marginRule: 'single', headerRule: false, holes: 'punch2' },
    },
  },
  {
    id: 'spiral',
    label: 'Spiral notebook',
    note: 'Wire binding, mirrored pages',
    group: 'Notebook',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8,
      paperColor: '#fdfcf6',
      ruleColor: '#9fb8d8',
      marginColor: '#d9634f',
      margins: { top: 20, right: 12, bottom: 14, left: 30 },
      features: { marginRule: 'single', headerRule: false, holes: 'spiral', mirrorEvenPages: true },
    },
  },
  {
    id: 'torn',
    label: 'Torn-out sheet',
    note: 'Ragged edge, spiral holes',
    group: 'Notebook',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8,
      paperColor: '#fcfbf5',
      ruleColor: '#9fb8d8',
      marginColor: '#d9634f',
      margins: { top: 18, right: 12, bottom: 14, left: 26 },
      features: { marginRule: 'single', headerRule: false, holes: 'spiral', tornEdge: true },
    },
  },
  {
    id: 'four-line',
    label: 'Four-line practice',
    note: 'Sets a small x-height',
    group: 'Practice',
    apply: {
      paperStyle: 'four-line',
      lineSpacing: 10,
      letterSize: 0.3,
      paperColor: '#fefefb',
      ruleColor: '#8fa9c9',
      marginColor: '#d9634f',
      margins: { top: 22, right: 14, bottom: 16, left: 24 },
      features: { marginRule: 'single', headerRule: false },
    },
  },
  {
    id: 'seyes',
    label: 'Séyès (French)',
    note: '8 mm bands, 2 mm x-height',
    group: 'Practice',
    apply: {
      paperStyle: 'seyes',
      lineSpacing: 8,
      letterSize: 0.26,
      paperColor: '#fefefd',
      ruleColor: '#93a9d6',
      marginColor: '#d9634f',
      margins: { top: 24, right: 12, bottom: 16, left: 26 },
      features: { marginRule: 'single', headerRule: false },
    },
  },
  {
    id: 'graph',
    label: 'Graph paper',
    note: '5 mm squares',
    group: 'Grid',
    apply: {
      paperStyle: 'grid',
      lineSpacing: 10,
      paperColor: '#fbfcf8',
      ruleColor: '#9ec6ab',
      marginColor: '#c98f86',
      margins: { top: 15, right: 12, bottom: 12, left: 15 },
      features: { marginRule: 'none', headerRule: false },
    },
  },
  {
    id: 'dotted',
    label: 'Dot grid',
    note: 'Bullet-journal dots',
    group: 'Grid',
    apply: {
      paperStyle: 'dotted',
      lineSpacing: 10,
      paperColor: '#fcfbf7',
      ruleColor: '#b4b0a6',
      marginColor: '#c0bcb2',
      margins: { top: 15, right: 12, bottom: 12, left: 15 },
      features: { marginRule: 'none', headerRule: false },
    },
  },
  {
    id: 'engineering',
    label: 'Engineering pad',
    note: 'Pale green grid',
    group: 'Grid',
    apply: {
      paperStyle: 'grid',
      lineSpacing: 10,
      paperColor: '#f1f6ec',
      ruleColor: '#9dbfa2',
      marginColor: '#8aa88f',
      margins: { top: 18, right: 12, bottom: 14, left: 18 },
      features: { marginRule: 'none', headerRule: false },
    },
  },
  {
    id: 'legal-pad',
    label: 'Legal pad',
    note: 'Yellow, double margin',
    group: 'Office',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8.5,
      paperColor: '#fbf1a6',
      ruleColor: '#7fa3c8',
      marginColor: '#cf6152',
      margins: { top: 26, right: 10, bottom: 12, left: 32 },
      features: { marginRule: 'double', headerRule: true },
    },
  },
  {
    id: 'exam',
    label: 'Exam answer sheet',
    note: 'Printed frame, name line, page numbers',
    group: 'Office',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8.5,
      paperColor: '#fdfdfb',
      ruleColor: '#a9b6c6',
      marginColor: '#5f6b7a',
      margins: { top: 28, right: 16, bottom: 20, left: 22 },
      features: { marginRule: 'box', headerRule: true, nameDateLine: true, pageNumber: 'printed' },
    },
  },
  {
    id: 'cornell',
    label: 'Cornell notes',
    note: 'Cue column and summary box',
    group: 'Office',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 8.5,
      paperColor: '#fdfdf9',
      ruleColor: '#a8bdd6',
      marginColor: '#c96a5a',
      margins: { top: 24, right: 12, bottom: 14, left: 12 },
      features: { marginRule: 'none', headerRule: true, nameDateLine: true, cueColumn: 45, summaryBox: 52 },
    },
  },
  {
    id: 'register',
    label: 'Two columns',
    note: 'Ruled, divided down the middle',
    group: 'Office',
    apply: {
      paperStyle: 'ruled',
      lineSpacing: 7,
      paperColor: '#fdfcf8',
      ruleColor: '#b0b8c4',
      marginColor: '#9aa3b0',
      margins: { top: 18, right: 14, bottom: 14, left: 14 },
      features: { marginRule: 'none', headerRule: true, columns: 2, columnGap: 10, columnDivider: true },
    },
  },
  {
    id: 'plain',
    label: 'Plain copy paper',
    note: 'No rules at all',
    group: 'Plain',
    apply: {
      paperStyle: 'plain',
      lineSpacing: 9,
      paperColor: '#fdfdfb',
      ruleColor: '#c9c9c4',
      marginColor: '#c9c9c4',
      margins: { top: 22, right: 20, bottom: 20, left: 22 },
      features: { marginRule: 'none', headerRule: false },
    },
  },
  {
    id: 'ivory',
    label: 'Ivory letter paper',
    note: 'Warm, unruled, wide margins',
    group: 'Plain',
    apply: {
      paperStyle: 'plain',
      lineSpacing: 10,
      paperColor: '#f7efdc',
      ruleColor: '#d8cbb0',
      marginColor: '#d8cbb0',
      margins: { top: 26, right: 24, bottom: 24, left: 24 },
      features: { marginRule: 'none', headerRule: false },
    },
  },
  {
    id: 'recycled',
    label: 'Recycled kraft',
    note: 'Flecked, unruled',
    group: 'Plain',
    apply: {
      paperStyle: 'plain',
      lineSpacing: 9.5,
      paperColor: '#e9e2d1',
      ruleColor: '#c2b79f',
      marginColor: '#b9a98c',
      margins: { top: 22, right: 20, bottom: 20, left: 22 },
      features: { marginRule: 'none', headerRule: false },
    },
  },
  {
    id: 'diary',
    label: 'Diary page',
    note: 'A5, ruled, numbered',
    group: 'Small',
    apply: {
      paperSize: 'a5',
      paperStyle: 'ruled',
      lineSpacing: 7,
      paperColor: '#fdf9ef',
      ruleColor: '#cbbfa8',
      marginColor: '#c9a06a',
      margins: { top: 16, right: 12, bottom: 12, left: 14 },
      features: { marginRule: 'none', headerRule: true, pageNumber: 'printed', mirrorEvenPages: true },
    },
  },
  {
    id: 'index-card',
    label: 'Index card',
    note: '5 × 3 in, ruled',
    group: 'Small',
    apply: {
      paperSize: 'index-5x3',
      paperStyle: 'ruled',
      lineSpacing: 6.5,
      paperColor: '#fdfdfa',
      ruleColor: '#b9c6d6',
      marginColor: '#d18b7e',
      margins: { top: 10, right: 6, bottom: 6, left: 10 },
      features: { marginRule: 'single', headerRule: true },
    },
  },
];

export function findTemplate(id: string): PaperTemplate | undefined {
  return PAPER_TEMPLATES.find((t) => t.id === id);
}

/**
 * Write a template's paper settings into `s`. Features start from the defaults
 * so switching templates never leaves furniture behind from the last one.
 */
export function applyTemplate(s: Settings, id: string): Settings {
  const template = findTemplate(id);
  if (!template) return s;
  const { features, margins, ...rest } = template.apply;
  Object.assign(s, rest);
  s.template = template.id;
  s.features = { ...DEFAULT_FEATURES, ...features };
  if (margins) s.margins = { ...s.margins, ...margins };
  return s;
}
