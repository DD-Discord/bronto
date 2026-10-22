import type { Button, DocsProblem } from './types.js';

/** A unit pagination never splits: a paragraph, a code fence or a section. */
export type Chunk =
  | { kind: 'text'; markdown: string; heading: boolean; line: number }
  | { kind: 'section'; markdown: string; button: Button; line: number };

const TITLE = /^# +(\S.*?)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MARKER = /^>\s*\[!([^\]]*)\]/;
const SECTION_START = /^>\s*\[!section\]/;
const SECTION_LINK = /^>\s*\[!section\]\s*\[([^\]]*)\]\(([^)\s]*)\)\s*$/;
const TOPIC_FILE = /^([a-z0-9-]+)\.md$/;
const HTTPS_URL = /^https:\/\/\S+$/;
const MAX_LABEL = 80;

/** Splits one topic file into chunks per `---` part, plus the problems found on the way. */
export function parseSource(file: string, source: string): { title: string; segments: Chunk[][]; problems: DocsProblem[] } {
  const lines = source.split(/\r?\n/);
  const problems: DocsProblem[] = [];
  const problem = (line: number, message: string) => problems.push({ file, line, message });

  const titleMatch = TITLE.exec(lines[0] ?? '');
  if (!titleMatch) problem(1, 'the file must start with "# Title"');
  const title = titleMatch?.[1] ?? '';

  let segment: Chunk[] = [];
  const segments: Chunk[][] = [segment];
  let text: { start: number; lines: string[] } | null = null;
  let fence: { char: string; length: number } | null = null;

  const flushText = () => {
    if (!text) return;
    const markdown = text.lines.join('\n');
    segment.push({ kind: 'text', markdown, heading: /^#{2,3}\s/.test(markdown), line: text.start });
    text = null;
  };

  // Reads the section whose marker is at index `start`; returns the index of the first line after it.
  const readSection = (start: number): number => {
    let end = start + 1;
    const body: string[] = [];
    for (; end < lines.length; end++) {
      const line = lines[end] ?? '';
      if (!line.startsWith('>')) break;
      const unknown = MARKER.exec(line);
      if (unknown) problem(end + 1, `unknown marker [!${unknown[1]}]`);
      body.push(line.replace(/^> ?/, ''));
    }

    const link = SECTION_LINK.exec(lines[start] ?? '');
    const label = link?.[1] ?? '';
    const target = link?.[2] ?? '';
    if (!link) {
      problem(start + 1, 'a section marker needs a link: [!section] [label](topic file or https:// link)');
      return end;
    }
    if (label.length > MAX_LABEL) problem(start + 1, `the button label must be at most ${MAX_LABEL} characters`);
    else if (!label.trim()) problem(start + 1, 'the button label is empty');
    const topic = TOPIC_FILE.exec(target)?.[1];
    let button: Button | null = null;
    if (topic) button = { label, topic };
    else if (HTTPS_URL.test(target)) button = { label, url: target };
    else problem(start + 1, `section link "${target}" must be a topic file (name.md) or an https:// link`);
    if (!body.some((l) => l.trim())) problem(start + 1, 'a section needs text below its link');
    else if (button) segment.push({ kind: 'section', markdown: body.join('\n'), button, line: start + 1 });
    return end;
  };

  for (let i = titleMatch ? 1 : 0; i < lines.length; ) {
    const line = lines[i] ?? '';
    const fenceMark = FENCE.exec(line)?.[1];

    if (fence) {
      text?.lines.push(line);
      if (fenceMark && fenceMark[0] === fence.char && fenceMark.length >= fence.length && line.trim() === fenceMark) fence = null;
      i++;
    } else if (fenceMark) {
      fence = { char: fenceMark[0] ?? '`', length: fenceMark.length };
      text ??= { start: i + 1, lines: [] };
      text.lines.push(line);
      i++;
    } else if (!line.trim()) {
      flushText();
      i++;
    } else if (line.trim() === '---') {
      if (text) problem(i + 1, 'a blank line before --- is required (otherwise it underlines a heading)');
      flushText();
      segment = [];
      segments.push(segment);
      i++;
    } else if (SECTION_START.test(line)) {
      flushText();
      i = readSection(i);
    } else {
      const unknown = MARKER.exec(line);
      if (unknown) problem(i + 1, `unknown marker [!${unknown[1]}]`);
      if (TABLE_DELIMITER.test(line)) problem(i + 1, 'tables are not supported: Discord does not render them');
      text ??= { start: i + 1, lines: [] };
      text.lines.push(line);
      i++;
    }
  }
  flushText();
  if (fence) problem(lines.length, 'a code fence is never closed');

  return { title, segments, problems };
}
