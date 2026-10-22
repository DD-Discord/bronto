import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSource } from './parse.js';
import { parseTopic } from './paginate.js';
import type { DocsProblem, ModuleDocs, Topic } from './types.js';

/** Core's own user docs: bronto/docs/user/. */
export const CORE_DOCS = new URL('../../../../docs/user/', import.meta.url);

const TOPIC_ID = /^[a-z0-9-]{1,32}$/;
const MAX_TOPICS = 25;
/** The `core:go:<module>:<topic>:<page>:<signature>` custom ID leaves 75 characters for module and topic. */
const MAX_ID_BUDGET = 75;
const SUMMARY_LENGTH = 100;

/** Reads synchronously: it runs once at startup. `docs` is null when there is any problem. */
export function loadDocs(folder: URL, module: string): { docs: ModuleDocs | null; problems: DocsProblem[] } {
  const dir = folder.href.endsWith('/') ? folder : new URL(`${folder.href}/`);
  const problems: DocsProblem[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.md'));
  } catch {
    return { docs: null, problems: [{ file: fileURLToPath(dir), line: null, message: 'the docs folder cannot be read' }] };
  }

  const ids = files.map((name) => name.slice(0, -3));
  if (!ids.includes('index')) problems.push({ file: 'index.md', line: null, message: 'the folder needs an index.md' });
  if (ids.length > MAX_TOPICS) problems.push({ file: '', line: null, message: `a module has at most ${MAX_TOPICS} topics, found ${ids.length}` });

  const topics: Topic[] = [];
  let summary = '';
  for (const id of ids.sort(compareIds)) {
    const file = `${id}.md`;
    if (!TOPIC_ID.test(id)) {
      problems.push({ file, line: null, message: 'the topic ID (file name without .md) must match [a-z0-9-]{1,32}' });
      continue;
    }
    if (module.length + id.length > MAX_ID_BUDGET) {
      problems.push({ file, line: null, message: `module name and topic ID together may have at most ${MAX_ID_BUDGET} characters` });
      continue;
    }
    const source = readFileSync(new URL(file, dir), 'utf8');
    const parsed = parseTopic(id, source);
    problems.push(...parsed.problems);
    topics.push(parsed.topic);
    if (id === 'index') summary = summarize(source);
  }

  const known = new Set(topics.map((topic) => topic.id));
  for (const topic of topics) {
    for (const block of topic.pages.flat()) {
      if (block.kind === 'section' && 'topic' in block.button && !known.has(block.button.topic)) {
        problems.push({ file: `${topic.id}.md`, line: null, message: `the section links to "${block.button.topic}.md", which is not in the folder` });
      }
    }
  }

  if (problems.length) return { docs: null, problems };
  return { docs: { summary, topics }, problems };
}

/** `index` first, then by file name. */
function compareIds(a: string, b: string): number {
  if (a === 'index' || b === 'index') return a === 'index' ? (b === 'index' ? 0 : -1) : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The first non-heading text of the index, whitespace collapsed and cut to the select description limit. */
function summarize(source: string): string {
  const chunk = parseSource('index.md', source).segments.flat().find((c) => c.kind === 'text' && !c.heading);
  const text = chunk?.markdown.replace(/\s+/g, ' ').trim() ?? '';
  return text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH - 1)}…` : text;
}
