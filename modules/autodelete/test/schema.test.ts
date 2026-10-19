import { formatSchemaProblems, migrationTargets, prepareDatabase, schemaExpectations } from '@bronto/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { FakeAutodeleteDiscord } from './fake-discord.js';
import { autodeleteDb, autodeleteModule, CHANNEL, insertRule, OTHER_GUILD, prepareAutodeleteBot } from './harness.js';
import { rules } from '../src/db/schema.js';
import { upsertGuild } from '@bronto/core';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('autodelete schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [autodeleteModule()];
    const problems = await prepareDatabase(t.database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    expect(formatSchemaProblems(problems)).toBe('');
    const { rows } = await t.database.adminPool.query(
      "select tablename from pg_tables where schemaname = 'autodelete' order by tablename",
    );
    expect(rows.map((row: { tablename: string }) => row.tablename)).toEqual(['cooldowns', 'posts', 'rules']);
  });

  it('prepares the bot and hides the rows of other servers', async () => {
    await prepareAutodeleteBot(t, new FakeAutodeleteDiscord());
    await upsertGuild(t.database.admin, OTHER_GUILD);
    await insertRule(t, { channelId: CHANNEL });
    expect(await autodeleteDb(t).run(async (tx) => tx.select().from(rules))).toHaveLength(1);
    expect(await autodeleteDb(t, OTHER_GUILD).run(async (tx) => tx.select().from(rules))).toEqual([]);
  });
});
