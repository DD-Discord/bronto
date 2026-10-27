import { formatSchemaProblems, migrationTargets, prepareDatabase, schemaExpectations, upsertGuild } from '@bronto/core';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { rules } from '../src/db/schema.js';
import { CHANNEL, insertRule, mediaonlyDb, mediaonlyModule, OTHER_GUILD, prepareMediaonlyBot } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('mediaonly schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [mediaonlyModule()];
    const problems = await prepareDatabase(t.database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    expect(formatSchemaProblems(problems)).toBe('');
    const { rows } = await t.database.adminPool.query(
      "select tablename from pg_tables where schemaname = 'mediaonly' order by tablename",
    );
    expect(rows.map((row: { tablename: string }) => row.tablename)).toEqual(['rules']);
  });

  it('prepares the bot and hides the rows of other servers', async () => {
    const mb = await prepareMediaonlyBot(t, new FakeDiscordHttp());
    await upsertGuild(t.database.admin, OTHER_GUILD);
    await insertRule(t, { channelId: CHANNEL });
    expect(await mediaonlyDb(t).run(async (tx) => tx.select().from(rules))).toHaveLength(1);
    expect(await mediaonlyDb(t, OTHER_GUILD).run(async (tx) => tx.select().from(rules))).toEqual([]);
    await mb.bot.stop();
  });
});
