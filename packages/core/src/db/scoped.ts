import { sql } from 'drizzle-orm';
import { runInScope, type PendingEvents } from './context.js';
import type { Db, Tx } from './database.js';

/** Database access limited to one guild by RLS. Each `run` is one transaction. */
export interface ScopedDb {
  readonly guildId: string;
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** The same access for another guild; only for deliberate cross-guild work. */
  forGuild(guildId: string): ScopedDb;
}

export function createScopedDb(app: Db, guildId: string): ScopedDb {
  return {
    guildId,
    async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      // Each run owns its pending events: a nested run delivers its own after its own commit.
      const pendingEvents: PendingEvents = { deliveries: [], open: true };
      let result: T;
      try {
        result = await runInScope({ guildId, pendingEvents }, () =>
          app.transaction(async (tx) => {
            // Transaction-local, so a pooled connection never carries the guild into its next use.
            await tx.execute(sql`select set_config('app.guild_id', ${guildId}, true)`);
            return fn(tx);
          }),
        );
      } finally {
        pendingEvents.open = false;
      }
      // Listeners may read what the transaction wrote, so they start only after the commit.
      for (const deliver of pendingEvents.deliveries) deliver();
      return result;
    },
    forGuild(other: string): ScopedDb {
      return createScopedDb(app, other);
    },
  };
}
