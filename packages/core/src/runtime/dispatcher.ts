import { Collection, Events, Guild, type GatewayDispatchEvents } from 'discord.js';
import { afterCommit, inTransaction, runInScope } from '../db/context.js';
import { createCustomId } from '../interactions/components.js';
import type { ComponentSigner } from '../interactions/signing.js';
import type { Database } from '../db/database.js';
import { createScopedDb } from '../db/scoped.js';
import type { ModuleRuntime } from './context.js';
import type { ModuleEnablement } from './enablement.js';
import { outsideHandlerError, runInHandlerScope, type HandlerScope } from './handler-scope.js';
import { eventLabel, type DiscordEventName, type EventDefinition, type Listener } from './events.js';
import { askLabel, type AskDefinition, type AskOutcome } from './asks.js';
import { gateLabel, type GateResult } from './gates.js';
import type { KeyedQueue } from './queue.js';
import type { HandlerContext } from './types.js';

type DiscordListener = Extract<Listener, { kind: 'discord' }>;
type GatewayListener = Extract<Listener, { kind: 'gateway' }>;
type ModuleListener = Extract<Listener, { kind: 'module' }>;
type AskListener = Extract<Listener, { kind: 'ask' }>;

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
  /** Signs the custom IDs handlers create; null when no interaction secret is configured. */
  signer?: ComponentSigner | null;
  /** Clock for custom ID expiry, in milliseconds. */
  now?: () => number;
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
  private readonly signer: ComponentSigner | null;
  private readonly now: () => number;
  private readonly discordListeners = new Map<DiscordEventName, Array<{ runtime: ModuleRuntime; listener: DiscordListener }>>();
  private readonly gatewayListeners = new Map<string, Array<{ runtime: ModuleRuntime; listener: GatewayListener }>>();
  private readonly moduleListeners = new Map<EventDefinition<unknown>, Array<{ runtime: ModuleRuntime; listener: ModuleListener }>>();
  private readonly askListeners = new Map<AskDefinition<any, any, any>, Array<{ runtime: ModuleRuntime; listener: AskListener }>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(options: DispatcherOptions) {
    this.database = options.database;
    this.enablement = options.enablement;
    this.queue = options.queue;
    this.guildGate = options.guildGate;
    this.signer = options.signer ?? null;
    this.now = options.now ?? Date.now;
    for (const runtime of options.runtimes) {
      for (const listener of runtime.loaded.definition.listeners ?? []) {
        if (listener.kind === 'discord') {
          const entries = this.discordListeners.get(listener.event) ?? [];
          entries.push({ runtime, listener });
          this.discordListeners.set(listener.event, entries);
        } else if (listener.kind === 'gateway') {
          const entries = this.gatewayListeners.get(listener.event) ?? [];
          entries.push({ runtime, listener });
          this.gatewayListeners.set(listener.event, entries);
        } else if (listener.kind === 'ask') {
          const entries = this.askListeners.get(listener.ask) ?? [];
          entries.push({ runtime, listener });
          this.askListeners.set(listener.ask, entries);
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

  /** Raw gateway packet types at least one module listens to. */
  gatewayEvents(): GatewayDispatchEvents[] {
    return [...this.gatewayListeners.keys()] as GatewayDispatchEvents[];
  }

  /** Runs the listeners of enabled modules for a raw gateway packet of a guild; packets without `guild_id` are ignored. */
  handleGateway(packet: { t: string; d: unknown }): Promise<void> {
    const entries = this.gatewayListeners.get(packet.t);
    if (entries === undefined) return Promise.resolve();
    const data = packet.d as { guild_id?: unknown } | null;
    const guildId = typeof data?.guild_id === 'string' ? data.guild_id : null;
    if (guildId === null) return Promise.resolve();
    return this.track(this.runGateway(packet.t, entries, packet.d, guildId));
  }

  /** Hands an event to every listening module enabled in the guild, without waiting for them. */
  deliver<P>(event: EventDefinition<P>, payload: P, guildId: string, actorId: string | null = null): void {
    if (this.stopped) return;
    for (const { runtime, listener } of this.moduleListeners.get(event) ?? []) {
      if (!this.enablement.isEnabled(guildId, runtime.name)) continue;
      this.track(this.runHandler(runtime, guildId, actorId, eventLabel(event), (ctx) => listener.handler(ctx, payload)));
    }
  }

  /**
   * Runs `fn` as the module's handler for one guild. A thrown error is logged and returned.
   */
  async runHandler(
    runtime: ModuleRuntime,
    guildId: string,
    actorId: string | null,
    label: string,
    fn: (ctx: HandlerContext) => unknown,
    options: RunHandlerOptions = {},
  ): Promise<HandlerResult> {
    const state = { finished: false };
    const contexts = new Map<ModuleRuntime, HandlerContext>();
    const scope: HandlerScope = {
      contextFor: (target) => {
        // An API kept past its caller's run must not act for that run's guild and actor.
        if (state.finished) throw outsideHandlerError();
        let context = contexts.get(target);
        if (context === undefined) {
          context = this.contextFor(target, guildId, actorId, state);
          contexts.set(target, context);
        }
        return context;
      },
    };
    const ctx = this.contextFor(runtime, guildId, actorId, state);
    contexts.set(runtime, ctx);
    try {
      // Awaiting inside the scope keeps guild and actor visible to Drizzle defaults.
      await runInScope({ guildId, actorId, pendingEvents: null }, () =>
        runInHandlerScope(scope, async () => {
          await fn(ctx);
        }),
      );
    } catch (error) {
      const fields = { err: error, guildId, handler: label };
      if (options.expectedError?.(error) === true) {
        runtime.context.log.debug(fields, 'Handler stopped');
      } else {
        runtime.context.log.error(fields, 'Handler failed');
      }
      return { ok: false, error };
    } finally {
      state.finished = true;
    }
    return { ok: true };
  }

  /** Skips module events and queued tasks from now on; running handlers finish. */
  stop(): void {
    this.stopped = true;
  }

  /** Resolves once no handler started through handleDiscord, deliver or a module queue is still running. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /**
   * The context of `runtime` in one handler run. APIs borrow it with the caller's guild, actor and `state`, so their
   * emits end with the caller's run.
   */
  private contextFor(
    runtime: ModuleRuntime,
    guildId: string,
    actorId: string | null,
    state: { finished: boolean },
  ): HandlerContext {
    return {
      ...runtime.context,
      guildId,
      actorId,
      db: createScopedDb(this.database.app, guildId, runtime.dbRole),
      emit: (event, payload) => {
        if (event.owner !== runtime.name) {
          throw new Error(`Module "${runtime.name}" cannot emit ${eventLabel(event)}; modules emit only their own events.`);
        }
        if (state.finished) {
          throw new Error(
            `Module "${runtime.name}" emitted ${eventLabel(event)} after its handler finished; emit inside the handler or a queued task.`,
          );
        }
        afterCommit(() => this.deliver(event, payload, guildId, actorId));
      },
      check: (gate, payload) => {
        if (gate.owner !== runtime.name) {
          throw new Error(`Module "${runtime.name}" cannot check ${gateLabel(gate)}; modules check only their own gates.`);
        }
        if (state.finished) {
          throw new Error(
            `Module "${runtime.name}" checked ${gateLabel(gate)} after its handler finished; check inside the handler or a queued task.`,
          );
        }
        if (inTransaction()) {
          throw new Error(`Module "${runtime.name}" checked ${gateLabel(gate)} inside ctx.db.run; check before opening the transaction.`);
        }
        return this.track(this.runAsk(gate, payload, guildId, actorId));
      },
      ask: (ask, payload) => {
        if (ask.owner !== runtime.name) {
          throw new Error(`Module "${runtime.name}" cannot ask ${askLabel(ask)}; modules ask only their own asks.`);
        }
        if (state.finished) {
          throw new Error(
            `Module "${runtime.name}" asked ${askLabel(ask)} after its handler finished; ask inside the handler or a queued task.`,
          );
        }
        if (inTransaction()) {
          throw new Error(`Module "${runtime.name}" asked ${askLabel(ask)} inside ctx.db.run; ask before opening the transaction.`);
        }
        return this.track(this.runAsk(ask, payload, guildId, actorId));
      },
      customId: (component, args = [], target = {}) => {
        if (component.owner === null) {
          throw new Error(`Component "${component.name}" is not part of a module yet; list it in defineModule.`);
        }
        if (component.owner !== runtime.name) {
          throw new Error(`Module "${runtime.name}" cannot sign components of module "${component.owner}".`);
        }
        if (this.signer === null) throw new Error('Components need interactions.secret in the config.');
        return createCustomId(
          this.signer,
          component,
          { guildId, userId: target.userId ?? actorId, channelId: target.channelId ?? null },
          args,
          this.now(),
        );
      },
      queue: {
        run: (key, task) =>
          this.track(
            this.queue.run(`${runtime.name}/${guildId}/${key}`, async () => {
              // A task does not run once the bot stopped or the module was switched off in the guild.
              if (this.stopped || !this.enablement.isEnabled(guildId, runtime.name)) return;
              await this.runHandler(runtime, guildId, actorId, `queue:${key}`, task);
            }),
          ),
      },
    };
  }

  /** Asks the listeners one after another, folding each outcome into the ask's strategy until it is done. */
  private async runAsk<R>(ask: AskDefinition<any, any, R>, payload: unknown, guildId: string, actorId: string | null): Promise<R> {
    const { strategy } = ask;
    let state = strategy.initial();
    for (const { runtime, listener } of this.askListeners.get(ask) ?? []) {
      if (!this.enablement.isEnabled(guildId, runtime.name)) continue;
      let value: unknown;
      const run = this.runHandler(runtime, guildId, actorId, `ask:${askLabel(ask)}`, async (ctx) => {
        value = await listener.handler(ctx, payload);
      });
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), strategy.timeoutMs);
      });
      const result = await Promise.race([run, timeout]).finally(() => clearTimeout(timer));
      let outcome: AskOutcome;
      if (result === 'timeout') {
        runtime.context.log.warn({ guildId, handler: `ask:${askLabel(ask)}` }, 'Ask listener timed out');
        outcome = { module: runtime.name, kind: 'timeout' };
      } else if (!result.ok) {
        outcome = { module: runtime.name, kind: 'failed' };
      } else {
        outcome = { module: runtime.name, kind: 'answer', value };
      }
      const step = strategy.next(state, outcome);
      if ('done' in step) return step.done;
      state = step.state;
    }
    return strategy.finish(state);
  }

  private async runGateway(
    event: string,
    entries: Array<{ runtime: ModuleRuntime; listener: GatewayListener }>,
    data: unknown,
    guildId: string,
  ): Promise<void> {
    if (this.guildGate !== undefined && !(await this.guildGate(guildId))) return;
    const runs = entries
      .filter(({ runtime }) => this.enablement.isEnabled(guildId, runtime.name))
      .map(({ runtime, listener }) =>
        this.runHandler(runtime, guildId, null, `gateway:${event}`, (ctx) => listener.handler(ctx, data)),
      );
    await Promise.all(runs);
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
