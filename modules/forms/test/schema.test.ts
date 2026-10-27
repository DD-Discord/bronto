import { formatSchemaProblems, migrationTargets, prepareDatabase, schemaExpectations } from '@bronto/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { formsModule } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('forms schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [formsModule()];
    const problems = await prepareDatabase(t.database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    expect(formatSchemaProblems(problems)).toBe('');
    const { rows } = await t.database.adminPool.query(
      "select tablename from pg_tables where schemaname = 'forms' order by tablename",
    );
    expect(rows.map((row: { tablename: string }) => row.tablename)).toEqual(['drafts', 'forms', 'forums', 'openers', 'submissions']);
  });

  it('keeps the once-per-member index partial', async () => {
    const { rows } = await t.database.adminPool.query(
      "select indexdef from pg_indexes where schemaname = 'forms' and indexname = 'submissions_once_key'",
    );
    expect(rows[0].indexdef).toMatch(/UNIQUE.*\(form_id, user_id\).*WHERE/);
  });
});
