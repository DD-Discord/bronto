import type { Client } from 'discord.js';
import type { Logger } from 'pino';
import { ConfigError } from '../config/errors.js';
import { currentGuildId } from '../db/context.js';
import type { Database } from '../db/database.js';
import { moduleRoleName } from '../db/module-roles.js';
import { createScopedDb, type ScopedDb } from '../db/scoped.js';
import type { LoadedModule } from './loader.js';
import type { ApiOf, ModuleDefinition } from './module.js';
import type { ModuleContext } from './types.js';

/** Shared services every module context is built from. */
export interface RuntimeServices {
  client: Client;
  database: Database;
  log: Logger;
}

/** A loaded module together with its context and built API. */
export interface ModuleRuntime {
  readonly name: string;
  readonly loaded: LoadedModule;
  readonly context: ModuleContext;
  /** Postgres role the module's database work runs as; null (the app role) for a module without `db` and for core. */
  readonly dbRole: string | null;
  api: unknown;
}

/**
 * Builds each module's context, then its API. `modules` must be sorted by dependencies. Throws a ConfigError when a
 * module's database role name is too long for Postgres.
 */
export function createModuleRuntimes(modules: LoadedModule[], services: RuntimeServices): ModuleRuntime[] {
  const roles = moduleDbRoles(modules, services.database.appRole);
  const byName = new Map<string, ModuleRuntime>();
  const runtimes = modules.map((loaded) => {
    const runtime = createRuntime(loaded, services, byName, roles.get(loaded.definition.name) ?? null);
    byName.set(runtime.name, runtime);
    return runtime;
  });
  for (const runtime of runtimes) {
    const factory = runtime.loaded.definition.api;
    if (factory !== undefined) {
      runtime.api = factory({ ...runtime.context, db: () => scopedForCurrentGuild(services.database, runtime.dbRole) });
    }
  }
  return runtimes;
}

function createRuntime(
  loaded: LoadedModule,
  services: RuntimeServices,
  byName: Map<string, ModuleRuntime>,
  dbRole: string | null,
): ModuleRuntime {
  const name = loaded.definition.name;
  const dependencies = new Set((loaded.definition.dependsOn ?? []).map((dependency) => dependency.name));
  const context: ModuleContext = {
    module: name,
    log: services.log.child({ module: name }),
    config: loaded.config,
    client: services.client,
    modules: {
      get<M extends ModuleDefinition<any, any>>(definition: M): ApiOf<M> {
        if (!dependencies.has(definition.name)) {
          throw new Error(`Module "${name}" must list "${definition.name}" in dependsOn to use its API.`);
        }
        const target = byName.get(definition.name);
        if (target === undefined || target.api === undefined) {
          throw new Error(`Module "${definition.name}" has no API.`);
        }
        return target.api as ApiOf<M>;
      },
    },
  };
  return { name, loaded, context, dbRole, api: undefined };
}

/** Role names of the modules with a database, collecting every name that is too long. */
function moduleDbRoles(modules: LoadedModule[], appRole: string): Map<string, string> {
  const roles = new Map<string, string>();
  const problems: string[] = [];
  for (const { definition } of modules) {
    if (definition.db === undefined) continue;
    try {
      roles.set(definition.name, moduleRoleName(appRole, definition.name));
    } catch (error) {
      problems.push(`${definition.name}: ${(error as Error).message}`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return roles;
}

function scopedForCurrentGuild(database: Database, role: string | null): ScopedDb {
  const guildId = currentGuildId();
  if (guildId === null) {
    throw new Error('A module API used the database outside a guild handler.');
  }
  return createScopedDb(database.app, guildId, role);
}

/**
 * The runtime core's own commands run under. It is not a loaded module, so it has no listeners, hooks or tables, and it
 * depends on no module.
 */
export function createCoreRuntime(services: RuntimeServices): ModuleRuntime {
  const definition: ModuleDefinition = { name: 'core' };
  return {
    name: 'core',
    loaded: { packageName: '@bronto/core', definition, config: {} },
    context: {
      module: 'core',
      log: services.log.child({ module: 'core' }),
      config: {},
      client: services.client,
      modules: {
        get(dependency) {
          throw new Error(`Core does not use module APIs (asked for "${dependency.name}").`);
        },
      },
    },
    dbRole: null,
    api: undefined,
  };
}
