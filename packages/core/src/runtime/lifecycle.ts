import type { Database } from '../db/database.js';
import {
  deleteGuildRow,
  guildsDueForPurge,
  isGuildDue,
  markGuildLeft,
  markMissingGuildsLeft,
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

  /**
   * Registers a guild and runs guildReady for its enabled modules; concurrent and repeated calls share one run. A run
   * that fails to register the guild is dropped, so the next call tries again.
   */
  setUp(guildId: string, joined: boolean): Promise<void> {
    const existing = this.setups.get(guildId);
    if (existing !== undefined) return existing;
    const setup = this.runSetUp(guildId, joined);
    this.setups.set(guildId, setup);
    setup.catch(() => {
      // Only drop this run; the guild may have been forgotten and set up again meanwhile.
      if (this.setups.get(guildId) === setup) this.setups.delete(guildId);
    });
    return setup;
  }

  /** Resolves once the guild is set up, starting its set-up when none is running or finished. */
  ready(guildId: string): Promise<void> {
    return this.setUp(guildId, false);
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

  /**
   * Records every registered guild missing from `presentIds` as left (the bot was removed while offline) and announces
   * it. Returns those guilds.
   */
  async reconcile(presentIds: string[], at: Date = new Date()): Promise<string[]> {
    const left = await markMissingGuildsLeft(this.options.database.admin, presentIds, at);
    for (const guildId of left) {
      this.options.dispatcher.deliver(coreEvents.guildLeft, { guildId }, guildId);
      this.forget(guildId);
    }
    return left;
  }

  /** Deletes every guild whose grace period has passed, after its modules cleaned up. Returns the deleted guilds. */
  async purgeDueGuilds(now: Date = new Date()): Promise<string[]> {
    const admin = this.options.database.admin;
    const deleted: string[] = [];
    for (const guildId of await guildsDueForPurge(admin, now)) {
      // Cleanup checks before each module that the guild is still due, so a guild that came back keeps its data;
      // modules that already cleaned up before it returned stay cleaned up. The delete re-checks as well.
      if (!(await this.cleanUp(guildId, () => isGuildDue(admin, guildId, now)))) continue;
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
    await upsertGuild(database.admin, guildId);
    await enablement.load(guildId);
    if (joined) dispatcher.deliver(coreEvents.guildJoined, { guildId }, guildId);
    for (const runtime of runtimes) {
      const hook = runtime.loaded.definition.hooks?.guildReady;
      if (hook === undefined || !enablement.isEnabled(guildId, runtime.name)) continue;
      // A failing guildReady is logged by runHandler and does not stop the other modules.
      await dispatcher.runHandler(runtime, guildId, null, 'guildReady', (ctx) => hook(ctx));
    }
  }

  // Dependents clean up before the modules they depend on; every module runs even if one fails. When `stillDue`
  // resolves false before a module, cleanup stops and reports failure so the guild is kept.
  private async cleanUp(guildId: string, stillDue?: () => Promise<boolean>): Promise<boolean> {
    let succeeded = true;
    for (const runtime of [...this.options.runtimes].reverse()) {
      const hook = runtime.loaded.definition.hooks?.deleteGuildData;
      if (hook === undefined) continue;
      if (stillDue !== undefined && !(await stillDue())) return false;
      const result = await this.options.dispatcher.runHandler(runtime, guildId, null, 'deleteGuildData', (ctx) =>
        hook(ctx, guildId),
      );
      succeeded = succeeded && result.ok;
    }
    return succeeded;
  }
}
