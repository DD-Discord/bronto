import { checkDocs } from '@bronto/core/testing';
import { expect, it } from 'vitest';

it('has valid user docs', () => {
  const docs = checkDocs(new URL('../docs/user/', import.meta.url), 'forms');
  expect(docs.topics.map((topic) => topic.id)).toEqual(['index', 'build', 'buttons', 'fill', 'submissions']);
});
