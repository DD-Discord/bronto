import { formatSchemaProblems, migrationTargets, prepareDatabase, schemaExpectations, upsertGuild } from '@bronto/core';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { rules } from '../src/db/schema.js';
import { autothreadDb, autothreadModule, CHANNEL, insertRule, OTHER_GUILD, prepareAutothreadBot } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('autothread schema', () => {
  it('migrates and passes the guild isolation checks', async () => {
    const modules = [autothreadModule()];
    const problems = await prepareDatabase(t.database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    expect(formatSchemaProblems(problems)).toBe('');
    const { rows } = await t.database.adminPool.query(
      "select tablename from pg_tables where schemaname = 'autothread' order by tablename",
    );
    expect(rows.map((row: { tablename: string }) => row.tablename)).toEqual(['rules']);
  });

  it('prepares the bot, applies defaults and hides the rows of other servers', async () => {
    const ab = await prepareAutothreadBot(t, new FakeDiscordHttp());
    await upsertGuild(t.database.admin, OTHER_GUILD);
    await insertRule(t, { channelId: CHANNEL });
    const [row] = await autothreadDb(t).run(async (tx) => tx.select().from(rules));
    expect(row).toMatchObject({
      enabled: true,
      ignoreBots: true,
      nameFormat: '[Comments] {user.display}',
      slowmodeSeconds: 0,
      templateId: null,
      rename: false,
    });
    expect(await autothreadDb(t, OTHER_GUILD).run(async (tx) => tx.select().from(rules))).toEqual([]);
    await ab.bot.stop();
  });
});
