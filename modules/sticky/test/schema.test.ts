import { formatSchemaProblems, migrationTargets, prepareDatabase, schemaExpectations } from '@bronto/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { stickyModule } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('sticky schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [stickyModule()];
    const problems = await prepareDatabase(t.database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    expect(formatSchemaProblems(problems)).toBe('');
    const { rows } = await t.database.adminPool.query(
      "select tablename from pg_tables where schemaname = 'sticky' order by tablename",
    );
    expect(rows.map((row: { tablename: string }) => row.tablename)).toEqual(['stickies', 'sticky_state']);
  });
});
