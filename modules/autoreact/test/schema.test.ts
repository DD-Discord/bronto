import { formatSchemaProblems, migrationTargets, prepareDatabase, schemaExpectations, upsertGuild } from '@bronto/core';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { rules } from '../src/db/schema.js';
import { autoreactDb, autoreactModule, CHANNEL, insertRule, OTHER_GUILD, prepareAutoreactBot } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('autoreact schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [autoreactModule()];
    const problems = await prepareDatabase(t.database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    expect(formatSchemaProblems(problems)).toBe('');
    const { rows } = await t.database.adminPool.query(
      "select tablename from pg_tables where schemaname = 'autoreact' order by tablename",
    );
    expect(rows.map((row: { tablename: string }) => row.tablename)).toEqual(['rules']);
  });

  it('prepares the bot and hides the rows of other servers', async () => {
    const ab = await prepareAutoreactBot(t, new FakeDiscordHttp());
    await upsertGuild(t.database.admin, OTHER_GUILD);
    await insertRule(t, { channelId: CHANNEL, emojis: ['\u{1F44D}', '\u{1F389}'] });
    const [row] = await autoreactDb(t).run(async (tx) => tx.select().from(rules));
    expect(row).toMatchObject({ enabled: true, ignoreBots: true, emojis: ['\u{1F44D}', '\u{1F389}'], ignoredUserIds: [] });
    expect(await autoreactDb(t, OTHER_GUILD).run(async (tx) => tx.select().from(rules))).toEqual([]);
    await ab.bot.stop();
  });
});
