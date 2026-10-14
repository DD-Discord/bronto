import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { GUILD_GRACE_DAYS } from './constants.js';
import type { Db } from './database.js';
import { guilds } from './core-schema.js';

const DAY_MS = 86_400_000;

/** Registers a guild, or marks it present again after the bot left it. */
export async function upsertGuild(db: Db, guildId: string): Promise<void> {
  await db.insert(guilds).values({ id: guildId }).onConflictDoUpdate({ target: guilds.id, set: { leftAt: null } });
}

/** Records that the bot left a guild; its data is kept until the grace period ends. */
export async function markGuildLeft(db: Db, guildId: string, at: Date = new Date()): Promise<void> {
  await db.update(guilds).set({ leftAt: at }).where(eq(guilds.id, guildId));
}

/** Guilds the bot left at least `graceDays` ago. */
export async function guildsDueForPurge(
  db: Db,
  now: Date = new Date(),
  graceDays: number = GUILD_GRACE_DAYS,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - graceDays * DAY_MS);
  const rows = await db
    .select({ id: guilds.id })
    .from(guilds)
    .where(and(isNotNull(guilds.leftAt), lte(guilds.leftAt, cutoff)))
    .orderBy(asc(guilds.id));
  return rows.map((row) => row.id);
}

/** Deletes the guild row; foreign keys cascade the delete into every guild table. */
export async function deleteGuildRow(db: Db, guildId: string): Promise<void> {
  await db.delete(guilds).where(eq(guilds.id, guildId));
}
