import {
  createBot,
  createDatabase,
  guildExists,
  loadConfig,
  loadModules,
  purgeModuleSchema,
  type CoreConfig,
  type LoadedModule,
  type ModuleImporter,
} from '@bronto/core';
import type { Client } from 'discord.js';
import type { Logger } from 'pino';

/** A problem the user can fix; the CLI prints its message without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CommandDeps {
  importer: ModuleImporter;
  env: Record<string, string | undefined>;
  log: Logger;
  createClient: (modules: LoadedModule[]) => Client;
}

export interface RunningBot {
  stop(): Promise<void>;
}

async function readConfig(path: string, env: CommandDeps['env']): Promise<CoreConfig> {
  try {
    return await loadConfig(path, env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`Config file not found: ${path}`);
    throw error;
  }
}

/** Starts the bot and resolves once it is logged in. */
export async function runStart(configPath: string, deps: CommandDeps): Promise<RunningBot> {
  const config = await readConfig(configPath, deps.env);
  const modules = await loadModules(config.modules, deps.importer);
  const database = createDatabase(config.database);
  const bot = createBot({ config, modules, database, client: deps.createClient(modules), log: deps.log });
  try {
    await bot.start();
  } catch (error) {
    await bot.stop().catch(() => undefined);
    await database.end();
    throw error;
  }
  deps.log.info({ modules: modules.map((module) => module.definition.name) }, 'Bot started');
  return {
    async stop() {
      await bot.stop();
      await database.end();
    },
  };
}

/** Drops a module's schema and migration history. Refuses while the module is still loaded. */
export async function runPurge(configPath: string, moduleName: string, deps: CommandDeps): Promise<void> {
  const config = await readConfig(configPath, deps.env);
  const modules = await loadModules(config.modules, deps.importer);
  if (modules.some((module) => module.definition.name === moduleName)) {
    throw new CliError(`Module "${moduleName}" is still loaded; remove it from config.yaml first.`);
  }
  const database = createDatabase(config.database);
  try {
    await purgeModuleSchema(database, moduleName);
  } finally {
    await database.end();
  }
  deps.log.info({ module: moduleName }, 'Purged the module schema');
}

/**
 * Deletes all data of one guild now, after every module cleaned up. Refuses guilds without a row. Does not connect to
 * the gateway.
 */
export async function runDeleteGuild(configPath: string, guildId: string, deps: CommandDeps): Promise<void> {
  const config = await readConfig(configPath, deps.env);
  const modules = await loadModules(config.modules, deps.importer);
  const database = createDatabase(config.database);
  const client = deps.createClient(modules);
  // Cleanup hooks may call Discord's REST API, which only needs the token.
  client.rest.setToken(config.discord.token);
  const bot = createBot({ config, modules, database, client, log: deps.log });
  try {
    await bot.prepare();
    if (!(await guildExists(database.admin, guildId))) throw new CliError(`Guild ${guildId} is not known.`);
    await bot.lifecycle.deleteGuild(guildId);
  } finally {
    await bot.stop();
    await database.end();
  }
  deps.log.info({ guildId }, 'Deleted the guild data');
}
