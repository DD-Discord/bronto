import { parseSource, type Chunk } from './parse.js';
import type { DocsProblem, Page, Topic } from './types.js';

export const MESSAGE_TEXT_LIMIT = 4000;
export const MESSAGE_COMPONENT_LIMIT = 40;
/** Container, title text display, two select rows (2 each), the Back / n of m / Next row (4). */
export const RESERVED_COMPONENTS = 10;

const JOIN = '\n\n';
const SECTION_COMPONENTS = 3;

interface Cost { text: number; components: number }

/** Cost of appending `chunk` after `previous` on a page: adjacent text chunks share one block. */
function cost(chunk: Chunk, previous: Chunk | undefined): Cost {
  if (chunk.kind === 'section') return { text: chunk.markdown.length, components: SECTION_COMPONENTS };
  const joins = previous?.kind === 'text';
  return { text: chunk.markdown.length + (joins ? JOIN.length : 0), components: joins ? 0 : 1 };
}

/** Merges adjacent text chunks into one block. */
function toPage(chunks: Chunk[]): Page {
  const page: Page = [];
  for (const chunk of chunks) {
    const last = page[page.length - 1];
    if (chunk.kind === 'section') page.push({ kind: 'section', markdown: chunk.markdown, button: chunk.button });
    else if (last?.kind === 'text') last.markdown += JOIN + chunk.markdown;
    else page.push({ kind: 'text', markdown: chunk.markdown });
  }
  return page;
}

/** Fills pages greedily per segment; chunks are never split. */
export function paginate(file: string, title: string, segments: Chunk[][]): { pages: Page[]; problems: DocsProblem[] } {
  const textBudget = MESSAGE_TEXT_LIMIT - `# ${title}`.length;
  const componentBudget = MESSAGE_COMPONENT_LIMIT - RESERVED_COMPONENTS;
  const pages: Page[] = [];
  const problems: DocsProblem[] = [];

  for (const segment of segments) {
    let current: Chunk[] = [];
    let pageStart = 0;
    let used: Cost = { text: 0, components: 0 };
    const close = () => {
      if (current.length) pages.push(toPage(current));
      current = [];
      used = { text: 0, components: 0 };
    };

    for (let i = 0; i < segment.length; i++) {
      const chunk = segment[i] as Chunk;
      const add = cost(chunk, current[current.length - 1]);
      if (used.text + add.text <= textBudget && used.components + add.components <= componentBudget) {
        if (!current.length) pageStart = i;
        current.push(chunk);
        used = { text: used.text + add.text, components: used.components + add.components };
        continue;
      }
      if (!current.length) {
        problems.push({ file, line: chunk.line, message: 'this block is too long for one page' });
        continue;
      }
      // Prefer a cut before the page's last heading so the heading stays with what follows it.
      let cut = current.length;
      for (let j = current.length - 1; j > 0; j--) {
        const candidate = current[j] as Chunk;
        if (candidate.kind === 'text' && candidate.heading) { cut = j; break; }
      }
      i = pageStart + cut - 1;
      current.length = cut;
      close();
    }
    close();
  }

  if (!pages.length) pages.push([]);
  return { pages, problems };
}

/** Parses one topic file and splits it into pages. */
export function parseTopic(id: string, source: string): { topic: Topic; problems: DocsProblem[] } {
  const file = `${id}.md`;
  const parsed = parseSource(file, source);
  const { pages, problems } = paginate(file, parsed.title, parsed.segments);
  return { topic: { id, title: parsed.title, pages }, problems: [...parsed.problems, ...problems] };
}
