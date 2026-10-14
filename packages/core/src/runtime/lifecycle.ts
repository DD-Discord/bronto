import type { Database } from '../db/database.js';
import {
  deleteGuildRow,
  guildsDueForPurge,
  isGuildDue,
  markGuildLeft,
  purgeGuildIfDue,
  upsertGuild,
} from '../db/guilds.js';
import type { ModuleRuntime } from './context.js';
import type { Dispatcher } from './dispatcher.js';
import type { ModuleEnablement } from './enablement.js';
import { coreEvents } from './events.js';

export interface LifecycleOptions {
  runtimes: ModuleRuntime[];
  dispatcher: Dispatcher;
  enablement: ModuleEnablement;
  database: Database;
}

/** Registers guilds as the bot sees them, records when it leaves, and deletes data once the grace period ends. */
export class GuildLifecycle {
  private readonly options: LifecycleOptions;
  private readonly setups = new Map<string, Promise<void>>();

  constructor(options: LifecycleOptions) {
    this.options = options;
  }

  /** Registers a guild and runs guildReady for its enabled modules; concurrent and repeated calls share one run. */
  setUp(guildId: string, joined: boolean): Promise<void> {
    const existing = this.setups.get(guildId);
    if (existing !== undefined) return existing;
    const setup = this.runSetUp(guildId, joined);
    this.setups.set(guildId, setup);
    return setup;
  }

  /** Forgets a guild that became unavailable, so it is set up again when it returns. */
  forget(guildId: string): void {
    this.setups.delete(guildId);
    this.options.enablement.forget(guildId);
  }

  /** Records that the bot was removed from a guild; its data is kept for the grace period. */
  async leave(guildId: string, at: Date = new Date()): Promise<void> {
    await markGuildLeft(this.options.database.admin, guildId, at);
    this.options.dispatcher.deliver(coreEvents.guildLeft, { guildId }, guildId);
    this.forget(guildId);
  }

  /** Deletes every guild whose grace period has passed, after its modules cleaned up. Returns the deleted guilds. */
  async purgeDueGuilds(now: Date = new Date()): Promise<string[]> {
    const admin = this.options.database.admin;
    const deleted: string[] = [];
    for (const guildId of await guildsDueForPurge(admin, now)) {
      // The guild may have come back while earlier guilds were cleaned up.
      if (!(await isGuildDue(admin, guildId, now))) continue;
      // A guild that returns during its own cleanup keeps its rows (the delete re-checks), but its modules already cleaned up.
      if (!(await this.cleanUp(guildId))) continue;
      if (await purgeGuildIfDue(admin, guildId, now)) deleted.push(guildId);
    }
    return deleted;
  }

  /** Deletes one guild's data now, after its modules cleaned up. */
  async deleteGuild(guildId: string): Promise<void> {
    if (!(await this.cleanUp(guildId))) {
      throw new Error(`Cleanup failed for guild ${guildId}; its data was kept.`);
    }
    await deleteGuildRow(this.options.database.admin, guildId);
  }

  private async runSetUp(guildId: string, joined: boolean): Promise<void> {
    const { database, enablement, dispatcher, runtimes } = this.options;
    try {
      await upsertGuild(database.admin, guildId);
      await enablement.load(guildId);
    } catch (error) {
      // Not set up yet, so the next event for this guild tries again.
      this.setups.delete(guildId);
      throw error;
    }
    if (joined) dispatcher.deliver(coreEvents.guildJoined, { guildId }, guildId);
    for (const runtime of runtimes) {
      const hook = runtime.loaded.definition.hooks?.guildReady;
      if (hook === undefined || !enablement.isEnabled(guildId, runtime.name)) continue;
      await dispatcher.runHandler(runtime, guildId, null, 'guildReady', (ctx) => hook(ctx));
    }
  }

  // Dependents clean up before the modules they depend on; every module runs even if one fails.
  private async cleanUp(guildId: string): Promise<boolean> {
    let succeeded = true;
    for (const runtime of [...this.options.runtimes].reverse()) {
      const hook = runtime.loaded.definition.hooks?.deleteGuildData;
      if (hook === undefined) continue;
      const ok = await this.options.dispatcher.runHandler(runtime, guildId, null, 'deleteGuildData', (ctx) =>
        hook(ctx, guildId),
      );
      succeeded = succeeded && ok;
    }
    return succeeded;
  }
}
