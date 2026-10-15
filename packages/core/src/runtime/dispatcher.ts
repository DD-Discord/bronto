import { Collection, Events, Guild } from 'discord.js';
import { runInScope } from '../db/context.js';
import type { Database } from '../db/database.js';
import { createScopedDb } from '../db/scoped.js';
import type { ModuleRuntime } from './context.js';
import type { ModuleEnablement } from './enablement.js';
import { eventLabel, type DiscordEventName, type EventDefinition, type Listener } from './events.js';
import type { KeyedQueue } from './queue.js';
import type { HandlerContext } from './types.js';

type DiscordListener = Extract<Listener, { kind: 'discord' }>;
type ModuleListener = Extract<Listener, { kind: 'module' }>;

// These events mean the guild is gone or going; gating them would set the guild up again.
const UNGATED_EVENTS = new Set<DiscordEventName>([Events.GuildDelete, Events.GuildUnavailable]);

export interface DispatcherOptions {
  runtimes: ModuleRuntime[];
  database: Database;
  enablement: ModuleEnablement;
  /** Runs the tasks modules queue with `ctx.queue.run`. */
  queue: KeyedQueue;
  /** Decides whether gateway events of a guild run handlers; resolving false drops the event. */
  guildGate?: (guildId: string) => Promise<boolean>;
}

/** How a handler run ended; `error` is what the handler threw. */
export type HandlerResult = { ok: true } | { ok: false; error: unknown };

export interface RunHandlerOptions {
  /** Errors for which this returns true are logged at debug level instead of as failures. */
  expectedError?: (error: unknown) => boolean;
}

/** The guild a gateway event belongs to, or null for events outside a guild (DMs, user updates, ...). */
export function guildIdOf(value: unknown): string | null {
  if (value instanceof Guild) return value.id;
  if (value instanceof Collection) return guildIdOf(value.first());
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
  private readonly queue: KeyedQueue;
  private readonly guildGate: ((guildId: string) => Promise<boolean>) | undefined;
  private readonly discordListeners = new Map<DiscordEventName, Array<{ runtime: ModuleRuntime; listener: DiscordListener }>>();
  private readonly moduleListeners = new Map<EventDefinition<unknown>, Array<{ runtime: ModuleRuntime; listener: ModuleListener }>>();
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: DispatcherOptions) {
    this.database = options.database;
    this.enablement = options.enablement;
    this.queue = options.queue;
    this.guildGate = options.guildGate;
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

  /**
   * Runs the listeners of enabled modules for a gateway event once the guild gate lets it through; events without a
   * guild are ignored.
   */
  handleDiscord(event: DiscordEventName, args: unknown[]): Promise<void> {
    const guildId = guildIdOf(args[0]) ?? guildIdOf(args[1]);
    if (guildId === null) return Promise.resolve();
    return this.track(this.runDiscord(event, args, guildId));
  }

  /** Hands an event to every listening module enabled in the guild, without waiting for them. */
  deliver<P>(event: EventDefinition<P>, payload: P, guildId: string, actorId: string | null = null): void {
    for (const { runtime, listener } of this.moduleListeners.get(event) ?? []) {
      if (!this.enablement.isEnabled(guildId, runtime.name)) continue;
      this.track(this.runHandler(runtime, guildId, actorId, eventLabel(event), (ctx) => listener.handler(ctx, payload)));
    }
  }

  /**
   * Runs `fn` as the module's handler for one guild. Its emitted events are delivered only when it succeeds; a thrown
   * error is logged and returned.
   */
  async runHandler(
    runtime: ModuleRuntime,
    guildId: string,
    actorId: string | null,
    label: string,
    fn: (ctx: HandlerContext) => unknown,
    options: RunHandlerOptions = {},
  ): Promise<HandlerResult> {
    const emitted: Array<() => void> = [];
    let finished = false;
    const ctx: HandlerContext = {
      ...runtime.context,
      guildId,
      actorId,
      db: createScopedDb(this.database.app, guildId),
      emit: (event, payload) => {
        if (event.owner !== runtime.name) {
          throw new Error(`Module "${runtime.name}" cannot emit ${eventLabel(event)}; modules emit only their own events.`);
        }
        if (finished) {
          throw new Error(
            `Module "${runtime.name}" emitted ${eventLabel(event)} after its handler finished; emit inside the handler or a queued task.`,
          );
        }
        emitted.push(() => this.deliver(event, payload, guildId, actorId));
      },
      queue: {
        run: (key, task) =>
          this.track(
            this.queue.run(`${runtime.name}/${guildId}/${key}`, async () => {
              // A task queued before the module was switched off in the guild does not run.
              if (!this.enablement.isEnabled(guildId, runtime.name)) return;
              await this.runHandler(runtime, guildId, actorId, `queue:${key}`, task);
            }),
          ),
      },
    };
    try {
      // Awaiting inside the scope keeps guild and actor visible to Drizzle defaults.
      await runInScope({ guildId, actorId }, async () => {
        await fn(ctx);
      });
    } catch (error) {
      const fields = { err: error, guildId, handler: label };
      if (options.expectedError?.(error) === true) {
        runtime.context.log.debug(fields, 'Handler stopped');
      } else {
        runtime.context.log.error(fields, 'Handler failed');
      }
      return { ok: false, error };
    } finally {
      finished = true;
    }
    for (const send of emitted) send();
    return { ok: true };
  }

  /** Resolves once no handler started through handleDiscord, deliver or a module queue is still running. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async runDiscord(event: DiscordEventName, args: unknown[], guildId: string): Promise<void> {
    if (UNGATED_EVENTS.has(event)) {
      // The switches may have been forgotten already; without them every module would count as enabled.
      if (!this.enablement.isLoaded(guildId)) await this.enablement.load(guildId);
    } else if (this.guildGate !== undefined && !(await this.guildGate(guildId))) {
      return;
    }
    const runs = (this.discordListeners.get(event) ?? [])
      .filter(({ runtime }) => this.enablement.isEnabled(guildId, runtime.name))
      .map(({ runtime, listener }) =>
        this.runHandler(runtime, guildId, null, event, (ctx) => listener.handler(ctx, ...args)),
      );
    await Promise.all(runs);
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
