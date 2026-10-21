import {
  coreMigrationTarget,
  formatSchemaProblems,
  migrateAll,
  migrationTargets,
  prepareDatabase,
  schemaExpectations,
  upsertGuild,
} from '@bronto/core';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { CHANNEL, GUILD, stickyModule, templatesModule } from './harness.js';

const MIGRATIONS = fileURLToPath(new URL('../drizzle/', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

/** A copy of sticky's migrations folder holding only the first migration. */
async function firstMigrationOnly(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'sticky-migrations-'));
  await mkdir(join(folder, 'meta'));
  const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const first = journal.entries[0]!;
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [first] }));
  await copyFile(join(MIGRATIONS, `${first.tag}.sql`), join(folder, `${first.tag}.sql`));
  return folder;
}

describe('sticky schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [templatesModule(), stickyModule()];
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

  it('gives stickies stored before templates a template ID and keeps their copy', async () => {
    const legacy = await createTestDatabase();
    const folder = await firstMigrationOnly();
    try {
      await migrateAll(legacy.database, [coreMigrationTarget, { name: 'sticky', folder }]);
      await upsertGuild(legacy.database.admin, GUILD);
      await legacy.database.adminPool.query(
        `insert into sticky.stickies (channel_id, guild_id, webhook_id, webhook_token, template_channel_id, template_message_id, content, embeds)
         values ($1, $2, '100000000000000040', 'webhook-token', '100000000000000020', '100000000000000021', 'Read the rules.', '[{"title":"Rules"}]')`,
        [CHANNEL, GUILD],
      );

      const modules = [templatesModule(), stickyModule()];
      const problems = await prepareDatabase(legacy.database, {
        modules: migrationTargets(modules),
        expectations: schemaExpectations(modules),
      });
      expect(formatSchemaProblems(problems)).toBe('');
      const { rows } = await legacy.database.adminPool.query('select template_id, content, embeds from sticky.stickies');
      expect(rows).toEqual([{ template_id: expect.stringMatching(UUID), content: 'Read the rules.', embeds: [{ title: 'Rules' }] }]);
      const { rows: columns } = await legacy.database.adminPool.query(
        "select column_name, is_nullable from information_schema.columns where table_schema = 'sticky' and table_name = 'stickies' and column_name in ('template_id', 'content', 'embeds') order by column_name",
      );
      expect(columns).toEqual([
        { column_name: 'content', is_nullable: 'YES' },
        { column_name: 'embeds', is_nullable: 'YES' },
        { column_name: 'template_id', is_nullable: 'NO' },
      ]);
    } finally {
      await legacy.drop();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
