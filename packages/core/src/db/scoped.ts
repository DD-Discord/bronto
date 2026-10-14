import { sql } from 'drizzle-orm';
import { runInScope } from './context.js';
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
    run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return runInScope({ guildId }, () =>
        app.transaction(async (tx) => {
          // Transaction-local, so a pooled connection never carries the guild into its next use.
          await tx.execute(sql`select set_config('app.guild_id', ${guildId}, true)`);
          return fn(tx);
        }),
      );
    },
    forGuild(other: string): ScopedDb {
      return createScopedDb(app, other);
    },
  };
}
