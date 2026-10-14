/** Schema holding every module's migration history, one table per module. */
export const MIGRATIONS_SCHEMA = 'migrations';

/** Advisory lock key ("bron") held while migrating. */
export const MIGRATION_LOCK_KEY = 0x62726f6e;

/** Days a guild's data is kept after the bot leaves it. */
export const GUILD_GRACE_DAYS = 30;
