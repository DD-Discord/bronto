import { ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fenced, fitReport, MAX_REPORT_TEXT, textSection, type ReportLayout } from './layout.js';

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

describe('fitReport', () => {
  const build = (text: string) => (inFile: boolean, layout: ReportLayout) => [
    { kind: 'text' as const, text: '## Title' },
    { kind: 'separator' as const },
    ...textSection('Post', text, inFile, layout),
    { kind: 'button' as const, label: 'Open', url: 'https://example.com/x' },
  ];

  it('keeps everything inline when it fits', () => {
    const message = fitReport([false, true], 0x123456, build('short'));
    expect(message.files).toBeUndefined();
    expect(message.allowedMentions).toEqual({ parse: [] });
    const [container] = message.components as unknown as { type: number; accent_color: number; components: { type: number }[] }[];
    expect(container).toMatchObject({ type: ComponentType.Container, accent_color: 0x123456 });
    expect(container!.components.map((c) => c.type)).toEqual([ComponentType.TextDisplay, ComponentType.Separator, ComponentType.TextDisplay, ComponentType.ActionRow]);
  });

  it('moves the text to a file when it is over the limit', () => {
    const text = 'x'.repeat(MAX_REPORT_TEXT);
    const message = fitReport([false, true], 1, build(text));
    expect(message.files).toEqual([{ name: 'post.txt', data: Buffer.from(text) }]);
    expect(JSON.stringify(message.components)).toContain('attachment://post.txt');
  });

  it('uses the last mode when none fits', () => {
    const message = fitReport([false, true], 1, (inFile, layout) => [
      { kind: 'text', text: 'y'.repeat(MAX_REPORT_TEXT + 1) }, ...textSection('Post', 'z', inFile, layout, 'copy.txt'),
    ]);
    expect(message.files?.map((f) => f.name)).toEqual(['copy.txt']);
  });
});
