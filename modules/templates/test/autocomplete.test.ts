import { defineModule } from '@bronto/core';
import { eq } from 'drizzle-orm';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { templatesApi } from '../src/api.js';
import { createTemplatesModule, suggestTemplates } from '../src/index.js';
import { FORUM, GUILD, inHandler, prepareTemplatesBot, ready, templatesDb, type TemplatesBot } from './harness.js';
import { forums, templates } from '../src/db/schema.js';

// A module that uses the templates API, as the modules do that offer `suggestTemplates`.
const consumer = defineModule({ name: 'consumer', dependsOn: [createTemplatesModule()] });

let t: TestDatabase;
let tb: TemplatesBot;

beforeEach(async () => {
  t = await createTestDatabase();
  tb = await prepareTemplatesBot(t, new FakeDiscordHttp(), { extra: [{ packageName: '@test/consumer', definition: consumer, config: {} }] });
  await templatesDb(t).run(async (tx) => tx.insert(forums).values({ forumChannelId: FORUM }));
  await ready(tb);
});

afterEach(async () => {
  await tb?.bot.stop();
  await t?.drop();
});

describe('suggestTemplates', () => {
  it('lists matching templates with their date', async () => {
    const { id } = await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'welcome', content: 'Hi', embed: null }));
    await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'rules', content: 'Hi', embed: null }));
    const [row] = await templatesDb(t).run(async (tx) => tx.select().from(templates).where(eq(templates.id, id)));
    const runtime = tb.bot.runtimes.find((entry) => entry.name === 'consumer')!;
    let choices: unknown;
    const outcome = await tb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
      choices = await suggestTemplates(ctx, 'WEL', {});
    });
    if (!outcome.ok) throw outcome.error;
    expect(choices).toEqual([{ name: `welcome · ${row!.createdAt.toISOString().slice(0, 10)}`, value: id }]);
  });
});
