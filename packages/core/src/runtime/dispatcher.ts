import { runInScope } from '../db/context.js';
import type { Database } from '../db/database.js';
import { createScopedDb } from '../db/scoped.js';
import type { ModuleRuntime } from './context.js';
import type { ModuleEnablement } from './enablement.js';
import { eventLabel, type DiscordEventName, type EventDefinition, type Listener } from './events.js';
import type { HandlerContext } from './types.js';

type DiscordListener = Extract<Listener, { kind: 'discord' }>;
type ModuleListener = Extract<Listener, { kind: 'module' }>;

export interface DispatcherOptions {
  runtimes: ModuleRuntime[];
  database: Database;
  enablement: ModuleEnablement;
}

/** The guild a gateway event belongs to, or null for events outside a guild (DMs, user updates, ...). */
export function guildIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { guildId?: unknown; guild?: { id?: unknown } | null; message?: { guildId?: unknown } | null };
  if (typeof candidate.guildId === 'string') return candidate.guildId;
  if (typeof candidate.guild?.id === 'string') return candidate.guild.id;
  if (typeof candidate.message?.guildId === 'string') return candidate.message.guildId;
  return null;
}

/**
 * Runs module code for one guild at a time: gateway events, module and core events, and hooks. Handler errors are
 * logged with the module name and never reach discord.js or other modules.
 */
export class Dispatcher {
  private readonly database: Database;
  private readonly enablement: ModuleEnablement;
  private readonly discordListeners = new Map<DiscordEventName, Array<{ runtime: ModuleRuntime; listener: DiscordListener }>>();
  private readonly moduleListeners = new Map<EventDefinition<unknown>, Array<{ runtime: ModuleRuntime; listener: ModuleListener }>>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: DispatcherOptions) {
    this.database = options.database;
    this.enablement = options.enablement;
    for (const runtime of options.runtimes) {
      for (const listener of runtime.loaded.definition.listeners ?? []) {
        if (listener.kind === 'discord') {
          const entries = this.discordListeners.get(listener.event) ?? [];
          entries.push({ runtime, listener });
          this.discordListeners.set(listener.event, entries);
        } else {
          const entries = this.moduleListeners.get(listener.event) ?? [];
          entries.push({ runtime, listener });
          this.moduleListeners.set(listener.event, entries);
        }
      }
    }
  }

  /** Gateway events at least one module listens to. */
  discordEvents(): DiscordEventName[] {
    return [...this.discordListeners.keys()];
  }

  /** Runs the listeners of enabled modules for a gateway event; events without a guild are ignored. */
  handleDiscord(event: DiscordEventName, args: unknown[]): Promise<void> {
    const guildId = guildIdOf(args[0]);
    if (guildId === null) return Promise.resolve();
    const runs = (this.discordListeners.get(event) ?? [])
      .filter(({ runtime }) => this.enablement.isEnabled(guildId, runtime.name))
      .map(({ runtime, listener }) =>
        this.runHandler(runtime, guildId, null, event, (ctx) => listener.handler(ctx, ...args)),
      );
    return this.track(Promise.all(runs).then(() => undefined));
  }

  /** Hands an event to every listening module enabled in the guild, without waiting for them. */
  deliver<P>(event: EventDefinition<P>, payload: P, guildId: string, actorId: string | null = null): void {
    for (const { runtime, listener } of this.moduleListeners.get(event) ?? []) {
      if (!this.enablement.isEnabled(guildId, runtime.name)) continue;
      this.track(this.runHandler(runtime, guildId, actorId, eventLabel(event), (ctx) => listener.handler(ctx, payload)));
    }
  }

  /** Runs `fn` as the module's handler for one guild. Returns false, after logging, when it throws. */
  async runHandler(
    runtime: ModuleRuntime,
    guildId: string,
    actorId: string | null,
    label: string,
    fn: (ctx: HandlerContext) => unknown,
  ): Promise<boolean> {
    const emitted: Array<() => void> = [];
    const ctx: HandlerContext = {
      ...runtime.context,
      guildId,
      actorId,
      db: createScopedDb(this.database.app, guildId),
      emit: (event, payload) => {
        if (event.owner !== runtime.name) {
          throw new Error(`Module "${runtime.name}" cannot emit ${eventLabel(event)}; modules emit only their own events.`);
        }
        emitted.push(() => this.deliver(event, payload, guildId, actorId));
      },
    };
    try {
      // Awaiting inside the scope keeps guild and actor visible to Drizzle defaults.
      await runInScope({ guildId, actorId }, async () => {
        await fn(ctx);
      });
    } catch (error) {
      runtime.context.log.error({ err: error, guildId, handler: label }, 'Handler failed');
      return false;
    }
    for (const send of emitted) send();
    return true;
  }

  /** Resolves once no handler started by this dispatcher is still running. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    const done = () => {
      this.inFlight.delete(promise);
    };
    promise.then(done, done);
    return promise;
  }
}
