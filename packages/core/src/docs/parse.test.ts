import { describe, expect, it } from 'vitest';
import { parseSource } from './parse.js';

const problemsOf = (source: string) => parseSource('x.md', source).problems;

describe('parseSource', () => {
  it('reads the title from the first line', () => {
    const r = parseSource('x.md', '# Creating a sticky\n\nText.');
    expect(r.title).toBe('Creating a sticky');
    expect(r.segments).toEqual([[{ kind: 'text', markdown: 'Text.', heading: false, line: 3 }]]);
    expect(r.problems).toEqual([]);
  });

  it('splits chunks at blank lines', () => {
    const { segments } = parseSource('x.md', '# T\n\nOne\nstill one\n\n## Options\n\nTwo');
    expect(segments[0]).toEqual([
      { kind: 'text', markdown: 'One\nstill one', heading: false, line: 3 },
      { kind: 'text', markdown: '## Options', heading: true, line: 6 },
      { kind: 'text', markdown: 'Two', heading: false, line: 8 },
    ]);
  });

  it('keeps a code fence as one chunk', () => {
    const fence = '```md\nline\n\n# Not a title\n---\n> [!section] [A](b.md)\n| a | b |\n|---|---|\n```';
    const r = parseSource('x.md', `# T\n\n${fence}`);
    expect(r.segments).toEqual([[{ kind: 'text', markdown: fence, heading: false, line: 3 }]]);
    expect(r.problems).toEqual([]);
  });

  it('reads a section with a topic button', () => {
    const { segments, problems } = parseSource(
      'x.md',
      '# T\n\n> [!section] [Open](create.md)\n> **`/sticky create`**\n>\n> Creates a sticky.',
    );
    expect(problems).toEqual([]);
    expect(segments[0]).toEqual([{
      kind: 'section',
      markdown: '**`/sticky create`**\n\nCreates a sticky.',
      button: { label: 'Open', topic: 'create' },
      line: 3,
    }]);
  });

  it('reads a section with a link button', () => {
    const { segments, problems } = parseSource(
      'x.md',
      '# T\n\n> [!section] [Admin guide](https://example.com/a)\n> Hosting?',
    );
    expect(problems).toEqual([]);
    expect(segments[0]?.[0]).toMatchObject({ kind: 'section', button: { label: 'Admin guide', url: 'https://example.com/a' } });
  });

  it('ends a section at the first line not starting with >', () => {
    const { segments } = parseSource('x.md', '# T\n\n> [!section] [A](a.md)\n> Text\nAfter');
    expect(segments[0]?.map((c) => c.kind)).toEqual(['section', 'text']);
  });

  it('starts a new segment at ---', () => {
    const { segments, problems } = parseSource('x.md', '# T\n\nA\n\n---\n\nB');
    expect(problems).toEqual([]);
    expect(segments).toEqual([
      [{ kind: 'text', markdown: 'A', heading: false, line: 3 }],
      [{ kind: 'text', markdown: 'B', heading: false, line: 7 }],
    ]);
  });

  it('reports a first line that is not a title', () => {
    expect(problemsOf('Text')).toContainEqual({
      file: 'x.md', line: 1, message: expect.stringMatching(/must start with "# Title"/),
    });
  });

  it('reports --- without a blank line before it', () => {
    expect(problemsOf('# T\n\nText\n---')).toContainEqual({
      file: 'x.md', line: 4, message: expect.stringMatching(/blank line before ---/),
    });
  });

  it('reports tables outside code fences', () => {
    expect(problemsOf('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toContainEqual({
      file: 'x.md', line: 4, message: expect.stringMatching(/tables/),
    });
  });

  it('reports unknown markers', () => {
    expect(problemsOf('# T\n\n> [!note]\n> Text')).toContainEqual({
      file: 'x.md', line: 3, message: expect.stringMatching(/unknown marker \[!note\]/),
    });
  });

  it('reports a section without text', () => {
    expect(problemsOf('# T\n\n> [!section] [A](a.md)\n>\n\nAfter')).toContainEqual({
      file: 'x.md', line: 3, message: expect.stringMatching(/section needs text/),
    });
  });

  it.each(['../other/x.md', 'http://x', 'mailto:x'])('reports the section target %s', (target) => {
    expect(problemsOf(`# T\n\n> [!section] [A](${target})\n> Text`)).toContainEqual({
      file: 'x.md', line: 3, message: expect.stringMatching(/topic file .*or an https:\/\/ link/),
    });
  });

  it('reports a button label over 80 characters', () => {
    expect(problemsOf(`# T\n\n> [!section] [${'a'.repeat(81)}](a.md)\n> Text`)).toContainEqual({
      file: 'x.md', line: 3, message: expect.stringMatching(/80 characters/),
    });
  });
});
