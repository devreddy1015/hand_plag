import { describe, expect, it } from 'vitest';
import { EM_BOLD, EM_ITALIC, EM_SUB, EM_SUP, EM_UNDERLINE, parseBlocks } from '../src/engine/markup';

const kinds = (text: string, markdown = true) => parseBlocks(text, markdown).map((b) => b.kind);

describe('parseBlocks', () => {
  it('reads headings, lists, quotes, dividers and page breaks', () => {
    const blocks = parseBlocks('# One\n\n- item\n2. second\n> quoted\n---\n[[page]]\nplain', true);
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'blank',
      'list',
      'list',
      'quote',
      'divider',
      'pagebreak',
      'paragraph',
    ]);
    expect(blocks[0].level).toBe(1);
    expect(blocks[0].text).toBe('One');
    expect(blocks[2].marker).toBe('•');
    expect(blocks[3].marker).toBe('2.');
    expect(blocks[4].text).toBe('quoted');
  });

  it('honours only page breaks when markdown reading is off', () => {
    expect(kinds('# heading\n[[page]]\n- item', false)).toEqual(['paragraph', 'pagebreak', 'paragraph']);
    expect(parseBlocks('# heading', false)[0].text).toBe('# heading');
  });

  it('strips emphasis markers and records what they covered', () => {
    const [block] = parseBlocks('say **very** loud', true);
    expect(block.text).toBe('say very loud');
    expect(block.emphasis).not.toBeNull();
    const flags = block.emphasis!;
    expect(flags[block.text.indexOf('very')] & EM_BOLD).toBe(EM_BOLD);
    expect(flags[block.text.indexOf('say')] & EM_BOLD).toBe(0);
    expect(flags[block.text.indexOf('loud')] & EM_BOLD).toBe(0);
  });

  it('keeps both flags when emphasis nests', () => {
    const [block] = parseBlocks('**bold _and slanted_**', true);
    expect(block.text).toBe('bold and slanted');
    const flags = block.emphasis!;
    const at = block.text.indexOf('slanted');
    expect(flags[at] & EM_BOLD).toBe(EM_BOLD);
    expect(flags[at] & EM_ITALIC).toBe(EM_ITALIC);
    expect(flags[0] & EM_ITALIC).toBe(0);
  });

  it('underlines with double underscores', () => {
    const [block] = parseBlocks('__look here__', true);
    expect(block.text).toBe('look here');
    expect(block.emphasis![0] & EM_UNDERLINE).toBe(EM_UNDERLINE);
  });

  it('leaves lone asterisks and underscores alone', () => {
    expect(parseBlocks('2 * 3 = 6 and snake_case_name', true)[0].text).toBe('2 * 3 = 6 and snake_case_name');
  });

  it('unwraps links to their text', () => {
    expect(parseBlocks('see [the notes](https://example.com/x) today', true)[0].text).toBe('see the notes today');
  });

  it('measures the indent of a line', () => {
    const blocks = parseBlocks('    deep\n\tdeeper', true);
    expect(blocks[0].indentSpaces).toBe(4);
    expect(blocks[1].indentSpaces).toBe(4);
  });

  it('reads a diagram and its caption', () => {
    const blocks = parseBlocks('Before.\n![Figure 1. The cycle](pdf-3-1)\nAfter.', true);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'image', 'caption', 'paragraph']);
    expect(blocks[1].src).toBe('pdf-3-1');
    expect(blocks[2].text).toBe('Figure 1. The cycle');
  });

  it('reads a diagram with no caption', () => {
    const blocks = parseBlocks('![](pdf-3-1)', true);
    expect(blocks.map((b) => b.kind)).toEqual(['image']);
  });

  it('keeps diagrams even with markdown reading off', () => {
    const blocks = parseBlocks('# not a heading\n![A chart](fig-9)', false);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'image', 'caption']);
    expect(blocks[1].src).toBe('fig-9');
  });

  it('drops the blank lines at the end of a document', () => {
    expect(kinds('text\n\n\n')).toEqual(['paragraph']);
  });
});

describe('superscripts and subscripts', () => {
  const scripted = (text: string, markdown = true) => {
    const [block] = parseBlocks(text, markdown);
    const flags = block.emphasis ?? new Uint8Array(block.text.length);
    return { text: block.text, sup: [...block.text].filter((_, i) => flags[i] & EM_SUP).join(''), sub: [...block.text].filter((_, i) => flags[i] & EM_SUB).join('') };
  };

  it('reads braces, carets and chemical subscripts', () => {
    expect(scripted('E = mc^2')).toEqual({ text: 'E = mc2', sup: '2', sub: '' });
    expect(scripted('x^{n+1} and y_{i}')).toEqual({ text: 'xn+1 and yi', sup: 'n+1', sub: 'i' });
    expect(scripted('H_2O and CO_2')).toEqual({ text: 'H2O and CO2', sup: '', sub: '22' });
    expect(scripted('10^-3 m')).toEqual({ text: '10-3 m', sup: '-3', sub: '' });
  });

  it('leaves underscores in names alone', () => {
    expect(scripted('snake_case and file_name')).toEqual({ text: 'snake_case and file_name', sup: '', sub: '' });
  });

  it('writes Unicode superscripts and subscripts as small figures, markdown or not', () => {
    expect(scripted('CO₂ and x²', false)).toEqual({ text: 'CO2 and x2', sup: '2', sub: '2' });
  });

  it('keeps a full stop after a power out of it', () => {
    expect(scripted('about 2^10.')).toEqual({ text: 'about 210.', sup: '10', sub: '' });
  });
});
