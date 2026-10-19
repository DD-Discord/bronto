import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LegacyImportContext } from '@bronto/core';
import { SnowflakeUtil } from 'discord.js';
import { eq } from 'drizzle-orm';
import type { AutodeleteConfig } from './config.js';
import { cooldowns, posts, rules } from './db/schema.js';
import type { AutodeleteDiscord } from './discord.js';

const WEBHOOK_URL = /\/webhooks\/(\d+)\/([\w-]+)/;
const SNOWFLAKE = /^\d{15,25}$/;

type Loose = Record<string, unknown>;
const isRecord = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): string | null => (typeof value === 'string' && SNOWFLAKE.test(value) ? value : null);

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch {
    return [];
  }
}

interface LegacyRule {
  channelId: string;
  enabled: boolean;
  keepLatest: boolean;
  deleteOnLeave: boolean;
  cooldownMs: number;
  notifyDm: boolean;
  webhook: { id: string; token: string } | null;
  webhookThreadId: string | null;
}

function parseRule(raw: unknown): LegacyRule | null {
  if (!isRecord(raw)) return null;
  const channelId = id(raw.channelId);
  if (channelId === null) return null;
  const match = typeof raw.webhookUrl === 'string' ? WEBHOOK_URL.exec(raw.webhookUrl) : null;
  const cooldown = typeof raw.cooldown === 'number' && Number.isFinite(raw.cooldown) ? Math.max(0, Math.floor(raw.cooldown)) : 0;
  return {
    channelId,
    enabled: raw.enabled !== false,
    keepLatest: raw.deleteOnSend !== false,
    deleteOnLeave: raw.deleteOnLeave === true,
    cooldownMs: cooldown,
    notifyDm: raw.reportDeletionViaDm === true,
    webhook: match === null ? null : { id: match[1]!, token: match[2]! },
    webhookThreadId: id(raw.webhookThreadId),
  };
}

/** Only the member and message IDs are read; names and texts in the old files are ignored. */
function parsePost(raw: unknown): { userId: string; messageId: string } | null {
  if (!isRecord(raw)) return null;
  const userId = id(raw.memberId);
  const messageId = id(raw.messageId);
  return userId === null || messageId === null ? null : { userId, messageId };
}

/** Imports the rules, tracked posts and cooldowns of an older auto-delete bot's data folder at `path`. */
export async function importLegacyAutodelete(
  ctx: LegacyImportContext<AutodeleteConfig>,
  path: string,
  discord: AutodeleteDiscord,
): Promise<string[]> {
  const lines: string[] = [];
  const totals = { imported: 0, existing: 0, posts: 0, skipped: 0 };

  for (const guildId of (await listDir(path)).filter((name) => SNOWFLAKE.test(name))) {
    const channelsDir = join(path, guildId, 'channels');
    const files = (await listDir(channelsDir)).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      const rule = parseRule(await readJson(join(channelsDir, file)));
      if (rule === null) {
        totals.skipped += 1;
        lines.push(`${file.replace(/\.json$/, '')}: skipped (unreadable rule file)`);
        continue;
      }
      const memberDir = join(channelsDir, file.replace(/\.json$/, ''));
      const members = new Map<string, string>();
      for (const memberFile of (await listDir(memberDir)).filter((name) => name.endsWith('.json'))) {
        const post = parsePost(await readJson(join(memberDir, memberFile)));
        if (post !== null) members.set(post.userId, post.messageId);
      }
      const entries = [...members].map(([userId, messageId]) => ({ userId, messageId }));

      if (ctx.dryRun) {
        totals.imported += 1;
        totals.posts += entries.length;
        const hook = rule.webhook === null ? 'no webhook' : 'webhook not checked';
        lines.push(`${rule.channelId}: rule would import, ${entries.length} posts, ${hook}`);
        continue;
      }

      await ctx.registerGuild(guildId);
      const db = ctx.forGuild(guildId);
      const existing = await db.run(async (tx) =>
        tx.select({ channelId: rules.channelId }).from(rules).where(eq(rules.channelId, rule.channelId)),
      );
      if (existing.length > 0) {
        totals.existing += 1;
        lines.push(`${rule.channelId}: already imported, left as it is`);
        continue;
      }

      let log: { channelId: string; threadId: string | null } | null = null;
      if (rule.webhook !== null) {
        const found = await discord.checkWebhook(rule.webhook);
        if (found !== null) log = { channelId: rule.webhookThreadId ?? found.channelId, threadId: rule.webhookThreadId };
      }
      await db.run(async (tx) => {
        await tx
          .insert(rules)
          .values({
            channelId: rule.channelId,
            enabled: rule.enabled,
            keepLatest: rule.keepLatest,
            deleteOnLeave: rule.deleteOnLeave,
            cooldownMs: rule.cooldownMs,
            graceMs: 0,
            notifyDm: rule.notifyDm,
            logChannelId: log?.channelId ?? null,
            logThreadId: log?.threadId ?? null,
            logWebhookId: log === null ? null : rule.webhook!.id,
            logWebhookToken: log === null ? null : rule.webhook!.token,
          })
          .onConflictDoNothing();
        for (const { userId, messageId } of entries) {
          const postedAt = new Date(SnowflakeUtil.timestampFrom(messageId));
          await tx.insert(posts).values({ messageId, channelId: rule.channelId, userId, postedAt }).onConflictDoNothing();
          await tx.insert(cooldowns).values({ channelId: rule.channelId, userId, messageId, postedAt }).onConflictDoNothing();
        }
      });
      totals.imported += 1;
      totals.posts += entries.length;
      const hook = rule.webhook === null ? 'no webhook' : log === null ? 'webhook invalid, set log-channel by hand' : 'webhook reused';
      lines.push(`${rule.channelId}: rule imported, ${entries.length} posts, ${hook}`);
    }
  }

  if (ctx.dryRun) {
    lines.push(`${totals.imported} rules, ${totals.posts} posts, ${totals.skipped} skipped (dry run, nothing written)`);
  } else {
    lines.push(`${totals.imported} rules imported, ${totals.existing} already imported, ${totals.posts} posts`);
  }
  return lines;
}
