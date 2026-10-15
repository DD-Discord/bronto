import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LegacyImportContext } from '@bronto/core';
import type { APIEmbed } from 'discord.js';
import { eq } from 'drizzle-orm';
import type { StickyConfig } from './config.js';
import { stickies, stickyState } from './db/schema.js';
import type { StickyDiscord, WebhookCredentials } from './discord.js';
import { sendableEmbeds } from './message.js';

/** One sticky as the previous bot stored it, from either of its two record shapes. */
export interface LegacySticky {
  channelId: string;
  guildId: string | null;
  templateChannelId: string;
  templateMessageId: string;
  content: string;
  embeds: APIEmbed[];
  ignoreBots: boolean;
  silent: boolean;
  debounceMs: number;
  lastMessageId: string | null;
  webhookId: string;
  webhookToken: string | null;
  creatorId: string | null;
  /** A debounced repost was waiting when the old bot stopped. */
  repostPending: boolean;
}

const MAX_DEBOUNCE_MS = 86_400_000;
const WEBHOOK_URL = /\/webhooks\/(\d+)\/([\w-]+)/;

type Loose = Record<string, unknown>;
const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const child = (value: unknown, key: string): Loose | null => (isRecord(value) && isRecord(value[key]) ? (value[key] as Loose) : null);

/** JSON reviver for the previous bot's date encoding, `{"$date": "<ISO>"}`. */
export function reviveLegacyDates(_key: string, value: unknown): unknown {
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$date === 'string') return new Date(value.$date);
  return value;
}

/** Reads one old record; returns the reason it cannot be imported instead. */
export function parseLegacySticky(raw: unknown): LegacySticky | { skip: string } {
  if (!isRecord(raw)) return { skip: 'not a sticky record' };
  const channelId = id(raw.channelId) ?? id(child(raw, 'channel')?.id);
  if (channelId === null) return { skip: 'no channel' };
  const template = child(raw, 'template');
  const templateMessageId = id(template?.id) ?? id(raw.templateId);
  if (templateMessageId === null) return { skip: 'no template' };
  const url = typeof raw.webhookUrl === 'string' ? WEBHOOK_URL.exec(raw.webhookUrl) : null;
  const webhookId = url?.[1] ?? id(raw.webhookId);
  if (webhookId === null) return { skip: 'no webhook' };
  const debounce = typeof raw.debounce === 'number' && Number.isFinite(raw.debounce) ? Math.floor(raw.debounce) : 0;
  return {
    channelId,
    guildId: id(raw.guildId),
    // Records without a template object kept the template in the sticky's own channel.
    templateChannelId: id(child(template, 'channel')?.id) ?? channelId,
    templateMessageId,
    content: typeof raw.content === 'string' ? raw.content : '',
    embeds: sendableEmbeds(raw.embeds),
    ignoreBots: raw.ignoreBots !== false,
    silent: raw.silent !== false,
    debounceMs: Math.min(Math.max(debounce, 0), MAX_DEBOUNCE_MS),
    lastMessageId: id(child(raw, 'lastMessage')?.id) ?? id(raw.lastMessageId),
    webhookId,
    webhookToken: url?.[2] ?? null,
    creatorId: id(raw.creatorId),
    repostPending: raw.isDebouncing === true,
  };
}

type Kind = 'imported' | 'repaired' | 'skipped' | 'failed';

interface Outcome {
  kind: Kind;
  label: string;
  note: string;
}

// Error messages can carry request URLs; webhook URLs contain tokens.
const withoutSecrets = (text: string) => text.replace(/\/webhooks\/\d+\/[\w-]+/g, '/webhooks/…');

async function importOne(
  ctx: LegacyImportContext<StickyConfig>,
  discord: StickyDiscord,
  path: string,
  file: string,
): Promise<Outcome> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(path, file), 'utf8'), reviveLegacyDates);
  } catch {
    return { kind: 'skipped', label: file, note: 'unreadable JSON' };
  }
  const record = parseLegacySticky(raw);
  if ('skip' in record) return { kind: 'skipped', label: file, note: record.skip };
  const label = record.channelId;
  if (record.content === '' && record.embeds.length === 0) return { kind: 'skipped', label, note: 'nothing to post' };
  if (ctx.dryRun) {
    return {
      kind: 'imported',
      label,
      note: record.webhookToken === null ? 'would import (webhook needs its token looked up or replaced)' : 'would import',
    };
  }

  const channel = await discord.channelInfo(record.channelId);
  if (channel === null || channel.guildId === null) {
    return { kind: 'skipped', label, note: 'the channel no longer exists or the bot cannot see it' };
  }
  if (record.guildId !== null && record.guildId !== channel.guildId) {
    return { kind: 'skipped', label, note: 'the channel is in another server than recorded' };
  }
  const parentChannelId = channel.isThread ? channel.parentId : null;
  const webhookChannelId = parentChannelId ?? record.channelId;
  await ctx.registerGuild(channel.guildId);
  const db = ctx.forGuild(channel.guildId, record.creatorId);
  const existing = await db.run(async (tx) =>
    tx.select({ channelId: stickies.channelId }).from(stickies).where(eq(stickies.channelId, record.channelId)),
  );
  if (existing.length > 0) return { kind: 'skipped', label, note: 'already imported; left as it is' };

  let webhook: WebhookCredentials;
  let lastMessageId = record.lastMessageId;
  let outcome: Outcome = { kind: 'imported', label, note: 'imported' };
  if (record.webhookToken !== null) {
    webhook = { id: record.webhookId, token: record.webhookToken };
  } else {
    const token = await discord.findWebhookToken(webhookChannelId, record.webhookId);
    if (token !== null) {
      webhook = { id: record.webhookId, token };
      outcome = { kind: 'imported', label, note: 'imported (webhook token from Discord)' };
    } else {
      // Without its token the old webhook can neither post nor delete; the bot removes both with its own permissions.
      if (lastMessageId !== null) await discord.deleteChannelMessage(record.channelId, lastMessageId);
      await discord.deleteWebhookById(record.webhookId);
      webhook = await discord.createWebhook(webhookChannelId, ctx.config.webhookName);
      lastMessageId = null;
      outcome = { kind: 'repaired', label, note: 'repaired (new webhook; the next message posts a fresh sticky)' };
    }
  }

  await db.run(async (tx) => {
    await tx.insert(stickies).values({
      channelId: record.channelId,
      parentChannelId,
      webhookId: webhook.id,
      webhookToken: webhook.token,
      templateChannelId: record.templateChannelId,
      templateMessageId: record.templateMessageId,
      content: record.content,
      embeds: record.embeds,
      ignoreBots: record.ignoreBots,
      silent: record.silent,
      debounceMs: record.debounceMs,
    });
    await tx.insert(stickyState).values({
      channelId: record.channelId,
      lastMessageId,
      repostDueAt: record.repostPending ? new Date() : null,
    });
  });
  return outcome;
}

/** Imports the previous bot's sticky records (one JSON file per channel) from `path`. */
export async function importLegacyStickies(
  ctx: LegacyImportContext<StickyConfig>,
  path: string,
  discord: StickyDiscord,
): Promise<string[]> {
  const files = (await readdir(path)).filter((file) => file.endsWith('.json')).sort();
  const counts: Record<Kind, number> = { imported: 0, repaired: 0, skipped: 0, failed: 0 };
  const lines: string[] = [];
  for (const file of files) {
    let outcome: Outcome;
    try {
      outcome = await importOne(ctx, discord, path, file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { kind: 'failed', label: file.replace(/\.json$/, ''), note: `failed (${withoutSecrets(reason)})` };
    }
    counts[outcome.kind] += 1;
    lines.push(`${outcome.label}: ${outcome.kind === 'skipped' ? `skipped (${outcome.note})` : outcome.note}`);
  }
  lines.push(
    `${files.length} records: ${counts.imported} imported, ${counts.repaired} repaired, ${counts.skipped} skipped, ${counts.failed} failed` +
      (ctx.dryRun ? ' (dry run, nothing written)' : ''),
  );
  return lines;
}
