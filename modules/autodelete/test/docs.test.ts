import { checkDocs } from '@bronto/core/testing';
import { expect, it } from 'vitest';

it('has valid user docs', () => {
  const docs = checkDocs(new URL('../docs/user/', import.meta.url), 'autodelete');
  expect(docs.topics.map((topic) => topic.id)).toEqual(['index', 'create', 'manage', 'options', 'reports', 'reset']);
});
