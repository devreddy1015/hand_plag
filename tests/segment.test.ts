import { describe, expect, it } from 'vitest';
import { detectScripts, graphemes, isRtlParagraph, tokenize } from '../src/engine/segment';

describe('segment', () => {
  it('splits words on whitespace and counts spaces', () => {
    const tokens = tokenize('  Hello   world');
    expect(tokens.map((t) => t.units.join(''))).toEqual(['Hello', 'world']);
    expect(tokens.map((t) => t.spacesBefore)).toEqual([2, 3]);
    expect(tokens[0].units).toEqual(['H', 'e', 'l', 'l', 'o']);
  });

  it('counts a tab as four spaces', () => {
    expect(tokenize('\tx')[0].spacesBefore).toBe(4);
  });

  it('keeps grapheme clusters together', () => {
    expect(graphemes('éa')).toEqual(['é', 'a']);
    expect(graphemes('👍🏽!')).toEqual(['👍🏽', '!']);
  });

  it('lets Chinese and Japanese break between every character', () => {
    const tokens = tokenize('我爱你 ok');
    expect(tokens.map((t) => t.units.join(''))).toEqual(['我', '爱', '你', 'ok']);
    expect(tokens.map((t) => t.spacesBefore)).toEqual([0, 0, 0, 1]);
  });

  it('draws shaped scripts one word at a time', () => {
    const tokens = tokenize('नमस्ते दुनिया');
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.shaped && t.units.length === 1)).toBe(true);
  });

  it('detects right-to-left paragraphs from the first strong character', () => {
    expect(isRtlParagraph('  שלום world')).toBe(true);
    expect(isRtlParagraph('hello مرحبا')).toBe(false);
    expect(isRtlParagraph('123 مرحبا')).toBe(true);
  });

  it('detects scripts for font fallback', () => {
    expect([...detectScripts('Hi Привет नमस्ते 안녕 こんにちは 你好')].sort()).toEqual(
      ['cyrillic', 'devanagari', 'han', 'hangul', 'kana', 'latin'].sort(),
    );
  });
});
