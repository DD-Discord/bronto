import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { formatPath } from '../config/env.js';
import { ConfigError } from '../config/errors.js';
import type { ModuleDefinition } from './module.js';

export interface LoadedModule {
  /** Package name as listed in config.yaml. */
  packageName: string;
  definition: ModuleDefinition;
  /** The module's validated config section. */
  config: unknown;
}

/** Imports a module package by name; how names resolve is up to the deployment. */
export type ModuleImporter = (packageName: string) => Promise<unknown>;

/**
 * Imports every module listed in the config, validates its config section and returns the modules sorted so each
 * comes after the modules it depends on. All problems are reported together in one ConfigError.
 */
export async function loadModules(
  sections: Record<string, unknown>,
  importer: ModuleImporter,
): Promise<LoadedModule[]> {
  const problems: string[] = [];
  const loaded: LoadedModule[] = [];
  for (const [packageName, section] of Object.entries(sections)) {
    const path = ['modules', packageName];
    let exported: unknown;
    try {
      exported = await importer(packageName);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      problems.push(`${formatPath(path)}: cannot import the package (${reason})`);
      continue;
    }
    const definition = (exported as { default?: unknown } | null)?.default;
    if (!isModuleDefinition(definition)) {
      problems.push(`${formatPath(path)}: the package's default export is not a module definition`);
      continue;
    }
    loaded.push({ packageName, definition, config: parseSection(definition, section, path, problems) });
  }
  problems.push(...duplicateNames(loaded), ...foreignTables(loaded));
  if (problems.length > 0) throw new ConfigError(problems);
  return sortByDependencies(loaded);
}

function isModuleDefinition(value: unknown): value is ModuleDefinition {
  return typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string';
}

function parseSection(definition: ModuleDefinition, section: unknown, path: string[], problems: string[]): unknown {
  if (definition.config === undefined) {
    if (typeof section === 'object' && section !== null && Object.keys(section).length > 0) {
      problems.push(`${formatPath(path)}: module "${definition.name}" takes no settings`);
    }
    return {};
  }
  const result = definition.config.safeParse(section);
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`${formatPath([...path, ...issue.path.map(String)])}: ${issue.message}`);
    }
    return undefined;
  }
  return result.data;
}

function duplicateNames(modules: LoadedModule[]): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const { packageName, definition } of modules) {
    const other = seen.get(definition.name);
    if (other === undefined) {
      seen.set(definition.name, packageName);
    } else {
      problems.push(`${formatPath(['modules', packageName])}: module name "${definition.name}" is already used by ${other}`);
    }
  }
  return problems;
}

// Each module owns exactly one schema, named after it; migrations and purge rely on that.
function foreignTables(modules: LoadedModule[]): string[] {
  const problems: string[] = [];
  for (const { packageName, definition } of modules) {
    for (const value of Object.values(definition.db?.schema ?? {})) {
      if (!is(value, PgTable)) continue;
      const { schema, name } = getTableConfig(value);
      if (schema !== definition.name) {
        problems.push(
          `${formatPath(['modules', packageName])}: table "${schema ?? 'public'}.${name}" is outside the module's schema "${definition.name}"`,
        );
      }
    }
  }
  return problems;
}

function sortByDependencies(modules: LoadedModule[]): LoadedModule[] {
  const byName = new Map(modules.map((module) => [module.definition.name, module]));
  const missing: string[] = [];
  for (const { packageName, definition } of modules) {
    for (const dependency of definition.dependsOn ?? []) {
      if (!byName.has(dependency.name)) {
        missing.push(`${formatPath(['modules', packageName])}: depends on module "${dependency.name}", which is not loaded`);
      }
    }
  }
  if (missing.length > 0) throw new ConfigError(missing);

  const sorted: LoadedModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (module: LoadedModule, path: string[]): void => {
    const name = module.definition.name;
    const current = state.get(name);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw new ConfigError([`modules: dependency cycle ${[...path, name].join(' -> ')}`]);
    }
    state.set(name, 'visiting');
    for (const dependency of module.definition.dependsOn ?? []) {
      visit(byName.get(dependency.name)!, [...path, name]);
    }
    state.set(name, 'done');
    sorted.push(module);
  };
  for (const module of modules) visit(module, []);
  return sorted;
}
