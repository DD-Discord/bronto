import { runInScope } from '../db/context.js';
import type { Database, Tx } from '../db/database.js';
import { upsertGuild } from '../db/guilds.js';
import { createScopedDb, type ScopedDb } from '../db/scoped.js';
import type { ModuleRuntime } from './context.js';
import type { ModuleContext } from './types.js';

/** What a module's legacy importer can use. Writes go through `forGuild`, so they are guild-scoped like handlers. */
export interface LegacyImportContext<TConfig = any> extends ModuleContext<TConfig> {
  /** True for `--dry-run`: read and check the old data, but write nothing and call no external service. */
  readonly dryRun: boolean;
  /** Registers a guild so rows can reference it. */
  registerGuild(guildId: string): Promise<void>;
  /** Database access for one guild; rows written are attributed to `actorId` (null: the bot). */
  forGuild(guildId: string, actorId?: string | null): ScopedDb;
}

/** Imports data an older bot left behind from `path`; returns one report line per record plus a summary. */
export type LegacyImporter<TConfig = any> = (ctx: LegacyImportContext<TConfig>, path: string) => Promise<string[]>;

export interface LegacyImportOptions {
  runtime: ModuleRuntime;
  database: Database;
  path: string;
  dryRun: boolean;
}

export async function runLegacyImport(options: LegacyImportOptions): Promise<string[]> {
  const { runtime, database, dryRun } = options;
  const importer = runtime.loaded.definition.importLegacy;
  if (importer === undefined) throw new Error(`Module "${runtime.name}" has no legacy importer.`);
  const refuse = (): never => {
    throw new Error('A dry run writes nothing.');
  };
  const ctx: LegacyImportContext = {
    ...runtime.context,
    dryRun,
    registerGuild: async (guildId) => {
      if (dryRun) refuse();
      await upsertGuild(database.admin, guildId);
    },
    forGuild: (guildId, actorId = null) => (dryRun ? refuse() : attributed(createScopedDb(database.app, guildId), actorId)),
  };
  return importer(ctx, options.path);
}

function attributed(db: ScopedDb, actorId: string | null): ScopedDb {
  return {
    guildId: db.guildId,
    run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return runInScope({ guildId: db.guildId, actorId }, () => db.run(fn));
    },
    forGuild: (other) => attributed(db.forGuild(other), actorId),
  };
}
