import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { ComponentDefinition } from '../interactions/components.js';
import type { ScopedDb } from '../db/scoped.js';
import type { EventDefinition } from './events.js';
import type { AskDefinition } from './asks.js';
import type { GateDefinition, GateResult } from './gates.js';
import type { ApiOf, ModuleDefinition } from './module.js';

/**
 * Per-key serial queue of one module in one guild. Each task runs as a handler with its own context for the guild
 * and actor that queued it; a newer task replaces one still waiting for the same key.
 */
export interface ModuleQueue {
  run(key: string, task: (ctx: HandlerContext) => Promise<void>): Promise<void>;
}

export interface ModuleApis {
  /** The API of a module listed in this module's dependsOn. */
  get<M extends ModuleDefinition<any, any>>(definition: M): ApiOf<M>;
}

/** What a module can use outside a guild: start hooks and API construction. */
export interface ModuleContext<TConfig = any> {
  readonly module: string;
  readonly log: Logger;
  readonly config: TConfig;
  readonly client: Client;
  readonly modules: ModuleApis;
}

/**
 * Context of one handler run for one guild. In the context an API factory receives, `guildId`, `actorId`, `db`, `queue`,
 * `emit` and `customId` resolve to the calling handler's run at each access and throw outside a handler.
 */
export interface HandlerContext<TConfig = any> extends ModuleContext<TConfig> {
  readonly guildId: string;
  /** User who triggered the work, or null when the bot acts on its own. */
  readonly actorId: string | null;
  readonly db: ScopedDb;
  /** Sends one of this module's events: after the current `db.run` transaction commits (dropped if it rolls back), or at once outside a transaction. */
  emit<P>(event: EventDefinition<P>, payload: P): void;
  /**
   * Asks the listeners of the other enabled modules whether the action may go ahead, in dependency order; the first
   * denial stops the rest. A listener that throws or takes over 5 s denies. Only this module's gates; throws inside `db.run`.
   */
  check<P>(gate: GateDefinition<P>, payload: P): Promise<GateResult>;
  /**
   * Asks the listeners of the other enabled modules in dependency order and folds their answers with the ask's strategy.
   * A listener that throws or exceeds the strategy's timeout is reported to it as failed or timed out. Only this
   * module's asks; throws inside `db.run`.
   */
  ask<P, R>(ask: AskDefinition<P, any, R>, payload: P): Promise<R>;
  readonly queue: ModuleQueue;
  /**
   * A signed custom ID for one of this module's buttons, selects or modals, bound to this guild. `target.userId`
   * defaults to the actor; `target.channelId` defaults to the interaction's channel in interaction contexts. They count
   * only when the definition binds them; a binding without a value throws.
   */
  customId(component: ComponentDefinition, args?: string[], target?: { userId?: string; channelId?: string }): string;
}
