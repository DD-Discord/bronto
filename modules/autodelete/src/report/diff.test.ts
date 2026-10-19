import { describe, expect, it } from 'vitest';
import { fenced, foldedDiff } from './diff.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe('foldedDiff', () => {
  it('is empty for identical texts', () => {
    expect(foldedDiff('a\nb', 'a\nb')).toBe('');
  });

  it('keeps one context line around a change and folds the rest', () => {
    const before = lines(10);
    const after = [...before];
    after[4] = 'changed';
    expect(foldedDiff(before.join('\n'), after.join('\n'))).toBe(['…', '  line 4', '- line 5', '+ changed', '  line 6', '…'].join('\n'));
  });

  it('folds a long unchanged run between two changes', () => {
    const before = lines(8);
    const after = [...before];
    after[0] = 'first';
    after[7] = 'last';
    expect(foldedDiff(before.join('\n'), after.join('\n'))).toBe(
      ['- line 1', '+ first', '  line 2', '…', '  line 7', '- line 8', '+ last'].join('\n'),
    );
  });

  it('shows an added trailing line', () => {
    expect(foldedDiff('a\nb', 'a\nb\nc')).toBe('…\n  b\n+ c');
  });

  it('handles an empty side', () => {
    expect(foldedDiff('', 'a')).toBe('+ a');
    expect(foldedDiff('a', '')).toBe('- a');
  });
});

describe('fenced', () => {
  it('wraps text in a block with a language', () => {
    expect(fenced('x', 'diff')).toBe('```diff\nx\n```');
    expect(fenced('x')).toBe('```\nx\n```');
  });

  it('escapes fences so the text stays inside one block', () => {
    const block = fenced('before ``` after\n```js', 'diff');
    expect(block.match(/```/g)).toHaveLength(2);
    expect(block).toContain('`​`​`');
  });

  it.each([5, 8, 3, 4])('leaves no fence in a run of %d backticks', (count) => {
    const block = fenced(`a${'`'.repeat(count)}b`, 'diff');
    expect(block.match(/```/g)).toHaveLength(2);
  });
});
