import type { GatewayIntentBits, Partials } from 'discord.js';
import type { z } from 'zod';
import { assertModuleName } from '../db/names.js';
import { checkCommand, type CommandDefinition } from '../interactions/commands.js';
import type { ComponentDefinition } from '../interactions/components.js';
import type { EventDefinition, Listener } from './events.js';
import type { LegacyImporter } from './legacy.js';
import type { ApiContext, HandlerContext, ModuleContext } from './types.js';

export interface ModuleHooks<TConfig = any> {
  /** Runs once after the client is ready. */
  start?: (ctx: ModuleContext<TConfig>) => unknown;
  /** Runs for each guild once it is registered, with a context scoped to that guild. */
  guildReady?: (ctx: HandlerContext<TConfig>) => unknown;
  /**
   * Runs when the module stops working in a guild: it was switched off there, or the bot left. Stop timers and drop
   * in-memory state of the guild here; guildReady runs again if it comes back.
   */
  guildStopped?: (ctx: HandlerContext<TConfig>) => unknown;
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
  /** Top-level slash commands keyed by name; registered in a guild while the module is enabled there. */
  commands?: Record<string, CommandDefinition>;
  /** Buttons and modals, routed by the custom-ID prefix `<module>:<name>`. */
  components?: ComponentDefinition[];
  /** Discord permissions the bot needs for this module; missing ones are logged when a guild is set up. */
  botPermissions?: bigint[];
  api?: (ctx: ApiContext<TConfig>) => TApi;
  hooks?: ModuleHooks<TConfig>;
  /** Imports data of an older bot; run with `bronto import-legacy <module> <path>`. */
  importLegacy?: LegacyImporter<TConfig>;
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
  for (const [name, command] of Object.entries(definition.commands ?? {})) checkCommand(name, command);
  const componentNames = new Set<string>();
  for (const component of definition.components ?? []) {
    const label = component.kind === 'button' ? 'Button' : 'Modal';
    const key = `${component.kind}:${component.name}`;
    if (componentNames.has(key)) throw new Error(`${label} "${component.name}" is defined twice in module "${definition.name}".`);
    componentNames.add(key);
    if (component.owner !== null && component.owner !== definition.name) {
      throw new Error(`Component "${component.name}" already belongs to module "${component.owner}".`);
    }
    component.owner = definition.name;
  }
  return definition;
}
