import type { GatewayIntentBits, Partials } from 'discord.js';
import type { z } from 'zod';
import { assertModuleName } from '../db/names.js';
import type { EventDefinition, Listener } from './events.js';
import type { ApiContext, HandlerContext, ModuleContext } from './types.js';

export interface ModuleHooks<TConfig = any> {
  /** Runs once after the client is ready. */
  start?: (ctx: ModuleContext<TConfig>) => unknown;
  /** Runs for each guild once it is registered, with a context scoped to that guild. */
  guildReady?: (ctx: HandlerContext<TConfig>) => unknown;
  /** Cleans up anything outside the database before the guild's rows are deleted; throwing keeps the guild. */
  deleteGuildData?: (ctx: HandlerContext<TConfig>, guildId: string) => unknown;
}

export interface ModuleDefinition<TConfig = any, TApi = unknown> {
  /** Module name; also its Postgres schema and the prefix of its events, logs and queue keys. */
  name: string;
  dependsOn?: ModuleDefinition<any, any>[];
  intents?: GatewayIntentBits[];
  partials?: Partials[];
  /** Validates the module's section of config.yaml. */
  config?: z.ZodType<TConfig>;
  db?: {
    /** The module's schema file exports (tables, pgSchema). */
    schema: Record<string, unknown>;
    /** Folder drizzle-kit generated, e.g. `new URL('../drizzle/', import.meta.url)`. */
    migrations: URL;
  };
  events?: Record<string, EventDefinition<any>>;
  listeners?: Listener[];
  api?: (ctx: ApiContext<TConfig>) => TApi;
  hooks?: ModuleHooks<TConfig>;
}

export type ApiOf<M> = M extends ModuleDefinition<any, infer TApi> ? TApi : never;

export function defineModule<TConfig = Record<string, never>, TApi = undefined>(
  definition: ModuleDefinition<TConfig, TApi>,
): ModuleDefinition<TConfig, TApi> {
  assertModuleName(definition.name);
  if (definition.name === 'core') {
    throw new Error('Module name "core" is reserved.');
  }
  for (const event of Object.values(definition.events ?? {})) {
    if (event.owner !== null && event.owner !== definition.name) {
      throw new Error(`Event "${event.name}" already belongs to module "${event.owner}".`);
    }
    event.owner = definition.name;
  }
  return definition;
}
