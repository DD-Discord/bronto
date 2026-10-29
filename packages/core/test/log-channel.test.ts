import { ChannelType, type Client } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { logChannel } from '../src/channel-rules/log-channel.js';
import { POST_CHANNEL_TYPES } from '../src/channel-rules/channel-types.js';
import { defineEntity } from '../src/crud/entity.js';
import { channelKeyOption } from '../src/crud/keys.js';
import { crudSubcommands } from '../src/crud/subcommands.js';
import { upsertGuild } from '../src/db/guilds.js';
import { defineCommand } from '../src/interactions/commands.js';
import { InteractionRouter } from '../src/interactions/router.js';
import { createModuleRuntimes } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import type { HandlerContext } from '../src/runtime/types.js';
import { FakeDiscordHttp } from '../src/testing/discord-http.js';
import { fakeCommand } from '../src/testing/interactions.js';
import { captureLog, type LogLine } from '../src/testing/log.js';
import { createNativeTestClient, type NativeTestClient } from '../src/testing/native-client.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetRules } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, widgetsDb, type TestDatabase } from './test-db.js';

// Made-up IDs; tests never use real server data.
const GUILD = '100000000000000001';
const CHANNEL = '100000000000000010';
const OTHER_CHANNEL = '100000000000000011';
const THIRD_CHANNEL = '100000000000000012';
const LOG_CHANNEL = '100000000000000020';
const OTHER_LOG_CHANNEL = '100000000000000021';
const LOG_THREAD = '100000000000000022';
const USER = '100000000000000099';

const log = logChannel({
  table: widgetRules,
  webhookName: () => 'Rule reports',
  channelTypes: POST_CHANNEL_TYPES,
  descriptions: { logChannel: 'Channel or thread for reports', removeLogChannel: 'Stop sending reports' },
});

const rules = defineEntity({
  table: widgetRules,
  key: 'channelId',
  displayName: { singular: 'Rule', plural: 'Rules' },
  formatShort: (rule) => `<#${rule.channelId}>`,
});

const ruleCommand = defineCommand({
  description: 'Rules',
  subcommands: crudSubcommands(rules, {
    style: 'set',
    key: channelKeyOption({ description: 'Channel of the rule', channelTypes: POST_CHANNEL_TYPES }),
    fields: log.fields,
    hooks: { prepare: log.prepare, afterWrite: log.afterWrite, beforeDelete: log.beforeDelete },
  }),
});

let t: TestDatabase;
let discord: FakeDiscordHttp;
let native: NativeTestClient;
let router: InteractionRouter;
let lines: LogLine[];
let logger: ReturnType<typeof captureLog>['log'];

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await upsertGuild(t.database.admin, GUILD);
  discord = new FakeDiscordHttp();
  discord.addGuild(GUILD);
  for (const id of [CHANNEL, OTHER_CHANNEL, THIRD_CHANNEL, LOG_CHANNEL, OTHER_LOG_CHANNEL]) {
    discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
  }
  discord.addChannel(LOG_THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: LOG_CHANNEL });
  native = await createNativeTestClient(discord);
  ({ log: logger, lines } = captureLog());
  const definition = widgetsModule({ commands: { rule: ruleCommand } });
  const runtimes = createModuleRuntimes([{ packageName: '@test/widgets', definition, config: {} }], {
    client: native.client as Client,
    database: t.database,
    log: logger,
  });
  const enablement = new ModuleEnablement(t.database.admin);
  const dispatcher = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
  router = new InteractionRouter({
    sources: [{ runtime: runtimes[0]!, commands: { rule: ruleCommand }, components: [] }],
    dispatcher,
    enablement,
    guildGate: async () => true,
    log: logger,
    signer: null,
  });
});

afterAll(async () => {
  await native.client.destroy();
  await t.drop();
});

beforeEach(async () => {
  await t.database.admin.delete(widgetRules);
  discord.webhooks.clear();
  discord.deletedWebhooks.length = 0;
  native.requests.length = 0;
  lines.length = 0;
});

/** A channel option value as discord.js resolves it. */
const channelOption = (id: string, parentId?: string) => ({ id, isThread: () => parentId !== undefined, parentId: parentId ?? null });

async function say(subcommand: string, options: Record<string, unknown> = {}): Promise<string[]> {
  const fake = fakeCommand({ command: 'rule', subcommand, options, guildId: GUILD, channelId: CHANNEL, userId: USER });
  await router.handle(fake.asInteraction());
  return fake.responses.map((response) => (response.payload as { content?: string }).content ?? '');
}

const rows = () => t.database.admin.select().from(widgetRules).orderBy(widgetRules.channelId);
const webhookCreates = () => native.requests.filter((request) => request.method === 'POST' && /^\/channels\/\d+\/webhooks$/.test(request.path));
const webhookDeletes = () => native.requests.filter((request) => request.method === 'DELETE' && request.path.startsWith('/webhooks/'));

describe('logChannel', () => {
  it('stores a new webhook for a log channel', async () => {
    expect(await say('set', { 'log-channel': channelOption(LOG_CHANNEL) })).toEqual(['**Rule created.**']);
    const [row] = await rows();
    expect(row).toMatchObject({ channelId: CHANNEL, logChannelId: LOG_CHANNEL, logThreadId: null });
    const webhook = discord.webhooks.get(row!.logWebhookId!);
    expect(webhook?.channel_id).toBe(LOG_CHANNEL);
    expect(webhookCreates().map((request) => request.body)).toEqual([expect.objectContaining({ name: 'Rule reports' })]);
    expect(row!.logWebhookToken).toBe(webhook?.token);
  });

  it('reuses the webhook of another rule logging to the same channel', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    await say('set', { channel: channelOption(OTHER_CHANNEL), 'log-channel': channelOption(LOG_CHANNEL) });
    const [first, second] = await rows();
    expect(second).toMatchObject({ logWebhookId: first!.logWebhookId, logWebhookToken: first!.logWebhookToken });
    expect(webhookCreates()).toHaveLength(1);
  });

  it('rejects log-channel together with remove-log-channel', async () => {
    await say('set');
    expect(await say('set', { 'log-channel': channelOption(LOG_CHANNEL), 'remove-log-channel': true })).toEqual([
      'Use either `log-channel` or `remove-log-channel`, not both.',
    ]);
    expect(webhookCreates()).toEqual([]);
  });

  it('clears the log columns with remove-log-channel', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    const [created] = await rows();
    await say('set', { 'remove-log-channel': true });
    expect(await rows()).toEqual([expect.objectContaining({ logChannelId: null, logThreadId: null, logWebhookId: null, logWebhookToken: null })]);
    expect(discord.deletedWebhooks).toEqual([created!.logWebhookId]);
  });

  it('deletes the old webhook when the log channel changes', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    const [before] = await rows();
    await say('set', { 'log-channel': channelOption(OTHER_LOG_CHANNEL) });
    const [after] = await rows();
    expect(after).toMatchObject({ logChannelId: OTHER_LOG_CHANNEL });
    expect(after!.logWebhookId).not.toBe(before!.logWebhookId);
    expect(discord.deletedWebhooks).toEqual([before!.logWebhookId]);
  });

  it('keeps a webhook another rule still uses', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    await say('set', { channel: channelOption(OTHER_CHANNEL), 'log-channel': channelOption(LOG_CHANNEL) });
    await say('set', { channel: channelOption(THIRD_CHANNEL), 'log-channel': channelOption(LOG_CHANNEL) });
    await say('set', { 'log-channel': channelOption(OTHER_LOG_CHANNEL) });
    await say('remove', { channel: channelOption(OTHER_CHANNEL) });
    expect(webhookDeletes()).toEqual([]);
    expect((await rows()).map((row) => row.channelId)).toEqual([CHANNEL, THIRD_CHANNEL]);
  });

  it('deletes the webhook when the rule is deleted', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    const [created] = await rows();
    expect((await say('remove'))[0]).toContain('Rule deleted');
    expect(await rows()).toEqual([]);
    expect(discord.deletedWebhooks).toEqual([created!.logWebhookId]);
  });

  it('ignores an unknown webhook when deleting', async () => {
    await say('set', { 'log-channel': channelOption(LOG_CHANNEL) });
    discord.webhooks.clear();
    expect((await say('remove'))[0]).toContain('Rule deleted');
    expect(await rows()).toEqual([]);
    expect(webhookDeletes()).toHaveLength(1);
  });

  it('explains a missing Manage Webhooks permission', async () => {
    discord.override('POST', `/channels/${LOG_CHANNEL}/webhooks`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    try {
      expect(await say('set', { 'log-channel': channelOption(LOG_THREAD, LOG_CHANNEL) })).toEqual([
        `I need the Manage Webhooks permission in <#${LOG_CHANNEL}>.`,
      ]);
      expect(await rows()).toEqual([]);
    } finally {
      discord.clearOverride('POST', `/channels/${LOG_CHANNEL}/webhooks`);
    }
  });

  it('onRemoved logs and swallows errors', async () => {
    const webhook = discord.addWebhook(LOG_CHANNEL);
    const path = `/webhooks/${webhook.id}/${webhook.token}`;
    discord.override('DELETE', path, () => ({ status: 500, json: { code: 0, message: 'Synthetic failure' } }));
    const ctx = { guildId: GUILD, client: native.client, log: logger, db: widgetsDb(t.database, GUILD) } as unknown as HandlerContext;
    const removed = {
      guildId: GUILD,
      channelId: CHANNEL,
      logChannelId: LOG_CHANNEL,
      logThreadId: null,
      logWebhookId: webhook.id,
      logWebhookToken: webhook.token,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
      updatedBy: null,
    };
    try {
      await expect(log.onRemoved(ctx, removed)).resolves.toBeUndefined();
    } finally {
      discord.clearOverride('DELETE', path);
    }
    expect(lines).toEqual([
      expect.objectContaining({ level: 40, msg: 'Deleting the log webhook of a removed rule failed', channelId: CHANNEL, err: expect.anything() }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(webhook.token);
  });
});
