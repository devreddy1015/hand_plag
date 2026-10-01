import { describe, expect, it } from 'vitest';
import { hyphenPoint } from '../src/engine/segment';
import { cleanText, joinBroken } from '../src/import/shared';

describe('cleanText', () => {
  it('expands the ligatures a typesetter left behind', () => {
    expect(cleanText('the ﬁrst ﬂoor of the oﬃce')).toBe('the first floor of the office');
  });

  it('drops invisible characters and settles spaces', () => {
    expect(cleanText('soft­hyphen')).toBe('softhyphen');
    expect(cleanText('wide space   here')).toBe('wide space here');
    expect(cleanText('zero​width')).toBe('zerowidth');
  });

  it('closes the space a PDF leaves before punctuation', () => {
    expect(cleanText('ready , steady .')).toBe('ready, steady.');
  });

  it('keeps dashes that are really dashes', () => {
    expect(cleanText('well‐known')).toBe('well-known');
    expect(cleanText('a — long dash')).toBe('a — long dash');
  });
});

describe('joinBroken', () => {
  it('puts a hyphenated word back together', () => {
    expect(joinBroken(['the exam-', 'ination of it'])).toBe('the examination of it');
  });

  it('keeps a hyphen that belongs to the text', () => {
    expect(joinBroken(['a well-', 'Known name'])).toBe('a well- Known name');
    expect(joinBroken(['the state-', 'of-the-art'])).toBe('the state- of-the-art');
  });

  it('joins ordinary lines with a single space', () => {
    expect(joinBroken(['one', '  two  ', '', 'three'])).toBe('one two three');
  });
});

describe('hyphenPoint', () => {
  const at = (word: string, target = word.length - 3) => hyphenPoint([...word], target);

  it('breaks between two consonants', () => {
    expect(at('window', 4)).toBe(3); // win-dow
  });

  it('leaves at least three letters on each line', () => {
    expect(at('the', 2)).toBe(0);
    const point = at('rhythm', 3);
    expect(point === 0 || (point >= 3 && point <= 3)).toBe(true);
  });

  it('never breaks past the room available', () => {
    for (const target of [3, 4, 5, 6]) {
      const point = at('complicated', target);
      expect(point).toBeLessThanOrEqual(target);
    }
  });

  it('refuses short words', () => {
    expect(at('cat', 3)).toBe(0);
    expect(at('house', 3)).toBe(0);
  });
});
