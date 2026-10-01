import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, applyTemplate, findTemplate, PAPER_TEMPLATES, withDefaults } from '../src/engine';

describe('withDefaults', () => {
  it('fills in everything that is missing', () => {
    expect(withDefaults({})).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults('nonsense')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the settings it recognises', () => {
    const s = withDefaults({ letterSize: 0.42, pen: 'fountain', margins: { left: 40 }, jitter: { ink: 0 } });
    expect(s.letterSize).toBe(0.42);
    expect(s.pen).toBe('fountain');
    expect(s.margins.left).toBe(40);
    expect(s.margins.top).toBe(DEFAULT_SETTINGS.margins.top);
    expect(s.jitter.ink).toBe(0);
    expect(s.jitter.baseline).toBe(1);
  });

  it('refuses values the engine could not draw', () => {
    const s = withDefaults({
      pen: 'quill',
      paperStyle: 'papyrus',
      finish: 'hologram',
      inkColor: 'javascript:alert(1)',
      paperColor: 'red',
      letterSize: Number.NaN,
      messiness: '0.9',
      features: { marginRule: 'squiggle', holes: 'drilled', pageNumber: 'maybe', columns: 7 },
    });
    expect(s.pen).toBe(DEFAULT_SETTINGS.pen);
    expect(s.paperStyle).toBe(DEFAULT_SETTINGS.paperStyle);
    expect(s.finish).toBe(DEFAULT_SETTINGS.finish);
    expect(s.inkColor).toBe(DEFAULT_SETTINGS.inkColor);
    expect(s.paperColor).toBe(DEFAULT_SETTINGS.paperColor);
    expect(s.letterSize).toBe(DEFAULT_SETTINGS.letterSize);
    expect(s.messiness).toBe(DEFAULT_SETTINGS.messiness);
    expect(s.features.marginRule).toBe(DEFAULT_SETTINGS.features.marginRule);
    expect(s.features.holes).toBe(DEFAULT_SETTINGS.features.holes);
    expect(s.features.pageNumber).toBe(DEFAULT_SETTINGS.features.pageNumber);
    expect(s.features.columns).toBe(1);
  });

  it('does not share anything with the defaults it copied', () => {
    const s = withDefaults({});
    s.margins.left = 99;
    s.jitter.ink = 0;
    s.features.holes = 'spiral';
    expect(DEFAULT_SETTINGS.margins.left).toBe(28);
    expect(DEFAULT_SETTINGS.jitter.ink).toBe(1);
    expect(DEFAULT_SETTINGS.features.holes).toBe('none');
  });

  it('accepts a colour in either notation', () => {
    expect(withDefaults({ inkColor: '#abc' }).inkColor).toBe('#abc');
    expect(withDefaults({ inkColor: '#A1B2C3' }).inkColor).toBe('#A1B2C3');
  });
});

describe('templates', () => {
  it('leaves no furniture behind when switching', () => {
    const s = applyTemplate(structuredClone(DEFAULT_SETTINGS), 'cornell');
    expect(s.features.cueColumn).toBeGreaterThan(0);
    applyTemplate(s, 'plain');
    expect(s.features.cueColumn).toBe(0);
    expect(s.features.summaryBox).toBe(0);
    expect(s.features.marginRule).toBe('none');
  });

  it('records which template is in use, and every one is applicable', () => {
    for (const template of PAPER_TEMPLATES) {
      const s = applyTemplate(structuredClone(DEFAULT_SETTINGS), template.id);
      expect(s.template).toBe(template.id);
      expect(findTemplate(template.id)).toBe(template);
      expect(withDefaults(s)).toEqual(s);
    }
  });

  it('ignores a template it does not know', () => {
    const s = applyTemplate(structuredClone(DEFAULT_SETTINGS), 'papyrus-scroll');
    expect(s).toEqual(DEFAULT_SETTINGS);
  });
});
