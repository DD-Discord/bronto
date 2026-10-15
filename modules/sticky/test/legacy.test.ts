import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopedDb, runLegacyImport } from '@bronto/core';
import { Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { stickies } from '../src/db/schema.js';
import { FakeStickyDiscord } from './fake-discord.js';
import { GUILD, message, OTHER_GUILD, prepareStickyBot, ready, stateOf, stickyRows, USER, type StickyBot } from './harness.js';

// Made-up records in both shapes the previous bot wrote; no real server data.
const FLAT = '100000000000000110';
const NESTED = '100000000000000120';
const THREAD_ID = '100000000000000130';
const GONE = '100000000000000140';
const MOVED = '100000000000000150';
const PARENT = '100000000000000121';

let t: TestDatabase;
let discord: FakeStickyDiscord;
let sb: StickyBot;
let dir: string;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeStickyDiscord();
  sb = await prepareStickyBot(t, discord);
  dir = await mkdtemp(join(tmpdir(), 'sticky-legacy-'));
  discord.addChannel(FLAT, { guildId: GUILD, isThread: false, parentId: null });
  discord.addChannel(NESTED, { guildId: GUILD, isThread: false, parentId: null });
  discord.addChannel(THREAD_ID, { guildId: GUILD, isThread: true, parentId: PARENT });
  discord.addChannel(MOVED, { guildId: OTHER_GUILD, isThread: false, parentId: null });
});

afterEach(async () => {
  await sb.bot.stop();
  await t.drop();
});

async function write(files: Record<string, unknown>): Promise<void> {
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function runImport(dryRun = false): Promise<string[]> {
  const runtime = sb.bot.runtimes.find((candidate) => candidate.name === 'sticky')!;
  return runLegacyImport({ runtime, database: t.database, path: dir, dryRun });
}

function flatRecord(webhookId: string) {
  return {
    channelId: FLAT,
    templateId: '100000000000000111',
    webhookId,
    lastMessageId: '100000000000000113',
    creatorId: USER,
    content: 'Read the rules.',
    embeds: [],
    ignoreBots: true,
    silent: true,
  };
}

function nestedRecord(channelId: string, webhook: { id: string; token: string }, extra: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    channelId,
    channel: { id: channelId, name: 'general' },
    template: { id: '100000000000000122', channel: { id: '100000000000000123', name: 'templates' } },
    webhookId: webhook.id,
    webhookUrl: `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`,
    content: '',
    embeds: [{ type: 'rich', id: '100000000000000127', title: 'Welcome', thumbnail: { url: 'https://example.com/a.png', width: 1 } }],
    ignoreBots: false,
    silent: true,
    debounce: 1_800_000,
    isDebouncing: true,
    lastMessage: { id: '100000000000000125' },
    createdAt: { $date: '2024-01-02T03:04:05.000Z' },
    ...extra,
  };
}

describe('importLegacy', () => {
  it('imports both record shapes and reports every file without secrets', async () => {
    const shown = discord.addWebhook(FLAT, { owned: false });
    const nested = discord.addWebhook(NESTED, { owned: false });
    const threadHook = discord.addWebhook(PARENT, { owned: false });
    await write({
      [`${FLAT}.json`]: flatRecord(shown.id),
      [`${NESTED}.json`]: nestedRecord(NESTED, nested),
      [`${THREAD_ID}.json`]: nestedRecord(THREAD_ID, threadHook, {
        channel: { id: THREAD_ID, name: 'thread', parent: { id: PARENT, name: 'general' } },
        isDebouncing: false,
      }),
      // A channel the fake does not know.
      [`${GONE}.json`]: { ...flatRecord('100000000000000141'), channelId: GONE },
      'broken.json': '{ not json',
      [`${MOVED}.json`]: nestedRecord(MOVED, discord.addWebhook(MOVED, { owned: false })),
    });

    const lines = await runImport();
    expect(lines).toEqual([
      `${FLAT}: imported (webhook token from Discord)`,
      `${NESTED}: imported`,
      `${THREAD_ID}: imported`,
      `${GONE}: skipped (the channel no longer exists or the bot cannot see it)`,
      `${MOVED}: skipped (the channel is in another server than recorded)`,
      'broken.json: skipped (unreadable JSON)',
      '6 records: 3 imported, 0 repaired, 3 skipped, 0 failed',
    ]);
    const report = lines.join('\n');
    expect(report).not.toContain('fake-token');
    expect(report).not.toContain('/webhooks/');

    const rows = await stickyRows(t);
    expect(rows.map((row) => row.channelId)).toEqual([FLAT, NESTED, THREAD_ID]);
    expect(rows[0]).toMatchObject({ webhookToken: shown.token, templateChannelId: FLAT, createdBy: USER });
    expect(rows[1]).toMatchObject({
      webhookToken: nested.token,
      ignoreBots: false,
      debounceMs: 1_800_000,
      embeds: [{ title: 'Welcome', thumbnail: { url: 'https://example.com/a.png' } }],
      createdBy: null,
    });
    expect(rows[2]).toMatchObject({ parentChannelId: PARENT, webhookId: threadHook.id });
    expect((await stateOf(t, FLAT))?.lastMessageId).toBe('100000000000000113');
    expect((await stateOf(t, NESTED))?.repostDueAt).not.toBeNull();
    expect((await stateOf(t, THREAD_ID))?.repostDueAt).toBeNull();
  });

  it('replaces a webhook whose token Discord keeps to itself', async () => {
    discord.tokensVisible = false;
    const old = discord.addWebhook(FLAT, { owned: false });
    await write({ [`${FLAT}.json`]: flatRecord(old.id) });
    expect(await runImport()).toEqual([
      `${FLAT}: repaired (new webhook; the next message posts a fresh sticky)`,
      '1 records: 0 imported, 1 repaired, 0 skipped, 0 failed',
    ]);
    const [row] = await stickyRows(t);
    expect(row!.webhookId).not.toBe(old.id);
    expect(discord.webhooks.get(row!.webhookId)?.channelId).toBe(FLAT);
    expect(discord.deletedWebhooks).toEqual([old.id]);
    expect(discord.calls).toContain('deleteChannelMessage');
    expect((await stateOf(t, FLAT))?.lastMessageId).toBeNull();
  });

  it('leaves imported stickies alone when run again', async () => {
    discord.tokensVisible = false;
    await write({ [`${FLAT}.json`]: flatRecord(discord.addWebhook(FLAT, { owned: false }).id) });
    await runImport();
    const [first] = await stickyRows(t);
    const webhooksBefore = discord.webhooks.size;
    expect(await runImport()).toEqual([
      `${FLAT}: skipped (already imported; left as it is)`,
      '1 records: 0 imported, 0 repaired, 1 skipped, 0 failed',
    ]);
    expect(await stickyRows(t)).toEqual([first]);
    expect(discord.webhooks.size).toBe(webhooksBefore);
  });

  it('keeps going after a record fails', async () => {
    discord.missingWebhookPermission = true;
    const nested = discord.addWebhook(NESTED, { owned: false });
    await write({ [`${FLAT}.json`]: flatRecord('100000000000000199'), [`${NESTED}.json`]: nestedRecord(NESTED, nested) });
    const lines = await runImport();
    expect(lines[0]).toMatch(new RegExp(`^${FLAT}: failed \\(`));
    expect(lines[1]).toBe(`${NESTED}: imported`);
    expect(lines[2]).toBe('2 records: 1 imported, 0 repaired, 0 skipped, 1 failed');
  });

  it('checks without calling Discord or writing in a dry run', async () => {
    await write({
      [`${FLAT}.json`]: flatRecord('100000000000000112'),
      [`${NESTED}.json`]: nestedRecord(NESTED, { id: '100000000000000124', token: 'fake-token-x' }),
    });
    expect(await runImport(true)).toEqual([
      `${FLAT}: would import (webhook needs its token looked up or replaced)`,
      `${NESTED}: would import`,
      '2 records: 2 imported, 0 repaired, 0 skipped, 0 failed (dry run, nothing written)',
    ]);
    expect(discord.calls).toEqual([]);
    expect(await stickyRows(t)).toEqual([]);
  });

  it('imports stickies that work once the bot runs', async () => {
    const nested = discord.addWebhook(NESTED, { owned: false });
    await write({ [`${NESTED}.json`]: nestedRecord(NESTED, nested, { isDebouncing: false, debounce: 0 }) });
    await runImport();
    await ready(sb);
    sb.client.emit(Events.MessageCreate, { ...message(NESTED) });
    await sb.bot.idle();
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0]!.webhookId).toBe(nested.id);
  });
});

describe('importLegacy failures', () => {
  // Inserts the sticky row between the existence check and the final write.
  function raceRow(channelId: string): void {
    const original = discord.createWebhook.bind(discord);
    const originalFind = discord.findWebhookToken.bind(discord);
    let raced = false;
    const insert = async () => {
      if (raced) return;
      raced = true;
      await createScopedDb(t.database.app, GUILD).run(async (tx) => {
        await tx.insert(stickies).values({
          channelId,
          webhookId: '100000000000000999',
          webhookToken: 'raced',
          templateChannelId: channelId,
          templateMessageId: '100000000000000998',
          content: 'raced',
        });
      });
    };
    discord.createWebhook = async (...args) => {
      const created = await original(...args);
      await insert();
      return created;
    };
    discord.findWebhookToken = async (...args) => {
      const token = await originalFind(...args);
      await insert();
      return token;
    };
  }

  it('reports a failed write without the token and removes the webhook it created', async () => {
    discord.tokensVisible = false;
    const old = discord.addWebhook(FLAT, { owned: false });
    await write({ [`${FLAT}.json`]: flatRecord(old.id) });
    raceRow(FLAT);
    const lines = await runImport();
    expect(lines[0]).toMatch(new RegExp(`^${FLAT}: failed \\(.*duplicate key.*; the old post and webhook were already removed, run the import again\\)$`));
    expect(lines.join('\n')).not.toContain('params:');
    const created = discord.deletedWebhooks.filter((webhookId) => webhookId !== old.id);
    expect(created).toHaveLength(1);
    expect(discord.webhooks.has(created[0]!)).toBe(false);
  });

  it('never prints a token Discord revealed when a write fails', async () => {
    const shown = discord.addWebhook(FLAT, { owned: false });
    await write({ [`${FLAT}.json`]: flatRecord(shown.id) });
    raceRow(FLAT);
    const lines = await runImport();
    expect(lines[0]).toMatch(new RegExp(`^${FLAT}: failed \\(`));
    expect(lines.join('\n')).not.toContain(shown.token);
    expect(lines.join('\n')).not.toContain('params:');
  });

  it('removes webhook URLs from failure lines', async () => {
    const nested = discord.addWebhook(NESTED, { owned: false });
    await write({ [`${NESTED}.json`]: { ...nestedRecord(NESTED, nested), webhookUrl: undefined, webhookId: nested.id } });
    discord.tokensVisible = true;
    discord.findWebhookToken = async () => {
      throw new Error('POST https://discord.com/api/webhooks/100000000000000124/fake-token-leak failed');
    };
    const lines = await runImport();
    expect(lines[0]).toBe(`${NESTED}: failed (POST https://discord.com/api/webhooks/…  failed)`.replace('…  ', '… '));
    expect(lines.join('\n')).not.toContain('fake-token-leak');
  });
});
