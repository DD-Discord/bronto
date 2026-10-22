import { describe, expect, it } from 'vitest';
import { checkDocs } from '../testing/docs.js';
import { loadDocs } from './load.js';

const fixture = (name: string) => new URL(`../../test/fixtures/docs/${name}/`, import.meta.url);

describe('loadDocs', () => {
  it('sorts by filename with index first', () => {
    const { docs, problems } = loadDocs(fixture('sorted'), 'demo');
    expect(problems).toEqual([]);
    expect(docs?.topics.map((t) => t.id)).toEqual(['index', '01-a', '02-b', 'c']);
  });

  it('reads the summary from index.md', () => {
    const { docs } = loadDocs(fixture('summary'), 'demo');
    expect(docs?.summary).toHaveLength(100);
    expect(docs?.summary.endsWith('…')).toBe(true);
  });

  it.each([
    ['rejects a folder without index.md', 'no-index', 'demo', /index\.md/],
    ['rejects a topic ID with capitals', 'capitals', 'demo', /Bad\.md.*\[a-z0-9-\]/],
    ['rejects a topic ID too long for the module name', 'long-id', 'a'.repeat(44), /75 characters/],
    ['rejects more than 25 topics', 'too-many', 'demo', /^index\.md: a module has at most 25/m],
    ['rejects a section linking to a missing topic', 'missing-link', 'demo', /gone\.md/],
  ])('%s', (_name, folder, module, message) => {
    const { docs, problems } = loadDocs(fixture(folder), module);
    expect(docs).toBeNull();
    expect(problems.map((p) => `${p.file}: ${p.message}`).join('\n')).toMatch(message);
  });

  it('reports an unreadable file instead of throwing', () => {
    const { docs, problems } = loadDocs(fixture('unreadable'), 'demo');
    expect(docs).toBeNull();
    expect(problems).toContainEqual({ file: 'bad.md', line: null, message: 'the file cannot be read' });
  });

  it('accepts a topic ID that fits the budget exactly', () => {
    expect(loadDocs(fixture('long-id'), 'a'.repeat(43)).problems).toEqual([]);
  });
});

describe('checkDocs', () => {
  it('throws with file and line', () => {
    expect(() => checkDocs(fixture('bad'), 'demo')).toThrow('bad.md:3:');
  });

  it('returns the docs when there is no problem', () => {
    expect(checkDocs(fixture('sorted'), 'demo').topics).toHaveLength(4);
  });
});
