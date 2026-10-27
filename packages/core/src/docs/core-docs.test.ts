import { describe, expect, it } from 'vitest';
import { checkDocs } from '../testing/docs.js';
import { CORE_DOCS } from './load.js';

describe('core docs', () => {
  it('pass the check', () => {
    expect(checkDocs(CORE_DOCS, 'core').topics.map((topic) => topic.id)).toEqual(['index', 'help', 'modules']);
  });
});
