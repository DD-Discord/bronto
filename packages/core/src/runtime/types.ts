import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import type { ScopedDb } from '../db/scoped.js';
import type { EventDefinition } from './events.js';
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

/** Context of one handler run for one guild. */
export interface HandlerContext<TConfig = any> extends ModuleContext<TConfig> {
  readonly guildId: string;
  /** User who triggered the work, or null when the bot acts on its own. */
  readonly actorId: string | null;
  readonly db: ScopedDb;
  /** Queues one of this module's events; it is delivered only if the handler succeeds. */
  emit<P>(event: EventDefinition<P>, payload: P): void;
  readonly queue: ModuleQueue;
}

/** Context an API factory receives; API functions run inside the calling handler's guild scope. */
export interface ApiContext<TConfig = any> extends ModuleContext<TConfig> {
  /** Database access for the guild of the handler that called the API. */
  db(): ScopedDb;
}
