import { describe, expect, it } from 'vitest';
import type { Chunk } from './parse.js';
import { paginate, parseTopic } from './paginate.js';

const text = (markdown: string, heading = false, line = 1): Chunk => ({ kind: 'text', markdown, heading, line });
const section = (markdown = 'body'): Chunk => ({ kind: 'section', markdown, button: { label: 'Go', topic: 'x' }, line: 1 });
const run = (segments: Chunk[][], title = 'T') => paginate('x.md', title, segments);

describe('paginate', () => {
  it('merges consecutive text into one block', () => {
    const { pages, problems } = run([[text('a'), text('b'), text('c')]]);
    expect(problems).toEqual([]);
    expect(pages).toEqual([[{ kind: 'text', markdown: 'a\n\nb\n\nc' }]]);
  });

  it('keeps one page per segment', () => {
    expect(run([[text('a')], [text('b')]]).pages).toHaveLength(2);
  });

  it('drops empty segments but keeps one empty page for an empty topic', () => {
    expect(run([[text('a')], [], []]).pages).toHaveLength(1);
    expect(run([[]]).pages).toEqual([[]]);
  });

  it('splits before the last heading that fits', () => {
    const { pages } = run([[text('a'.repeat(2000)), text('## H' + 'h'.repeat(1500), true), text('b'.repeat(1000))]]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual([{ kind: 'text', markdown: 'a'.repeat(2000) }]);
    expect(pages[1]).toEqual([{ kind: 'text', markdown: `## H${'h'.repeat(1500)}\n\n${'b'.repeat(1000)}` }]);
  });

  it('cuts right before an overflowing heading instead of an earlier one', () => {
    const { pages } = run([[text('A'.repeat(500)), text('## H1\n' + 'x'.repeat(500), true), text('B'.repeat(500)), text('## H2\n' + 'y'.repeat(2500), true)]]);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual([{ kind: 'text', markdown: `${'A'.repeat(500)}\n\n## H1\n${'x'.repeat(500)}\n\n${'B'.repeat(500)}` }]);
    expect(pages[1]).toEqual([{ kind: 'text', markdown: `## H2\n${'y'.repeat(2500)}` }]);
  });

  it('splits at a paragraph without a heading', () => {
    const p = 'p'.repeat(1500);
    const { pages } = run([[text(p), text(p), text(p)]]);
    expect(pages.map((page) => page.length)).toEqual([1, 1]);
    expect(pages[0]?.[0]).toEqual({ kind: 'text', markdown: `${p}\n\n${p}` });
  });

  it('counts components', () => {
    const { pages } = run([Array.from({ length: 11 }, () => section())]);
    expect(pages.map((page) => page.length)).toEqual([10, 1]);
  });

  it('never splits a section or fence', () => {
    const fence = '```\n' + 'x'.repeat(3000) + '\n```';
    const { pages, problems } = run([[text('a'.repeat(2000)), text(fence)]]);
    expect(problems).toEqual([]);
    expect(pages).toEqual([[{ kind: 'text', markdown: 'a'.repeat(2000) }], [{ kind: 'text', markdown: fence }]]);
  });

  it('rejects a chunk that cannot fit', () => {
    const { pages, problems } = run([[text('a'), text('p'.repeat(4000), false, 7)]]);
    expect(problems).toEqual([{ file: 'x.md', line: 7, message: expect.stringMatching(/too long for one page/) }]);
    expect(pages).toEqual([[{ kind: 'text', markdown: 'a' }]]);
  });
});

describe('parseTopic', () => {
  it('wires parsing and pagination', () => {
    const r = parseTopic('intro', '# Intro\n\nHello\n\n---\n\nWorld');
    expect(r.problems).toEqual([]);
    expect(r.topic.id).toBe('intro');
    expect(r.topic.title).toBe('Intro');
    expect(r.topic.pages).toHaveLength(2);
  });

  it('returns parser problems and still builds a topic', () => {
    const r = parseTopic('intro', 'No title\n\nHello');
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.topic.pages).toHaveLength(1);
  });
});
