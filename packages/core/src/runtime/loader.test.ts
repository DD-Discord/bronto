import { pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError } from '../config/errors.js';
import { loadModules, type ModuleImporter } from './loader.js';
import { defineModule, type ModuleDefinition } from './module.js';

function importerOf(packages: Record<string, unknown>): ModuleImporter {
  return async (name) => {
    if (!(name in packages)) throw new Error(`Cannot find package '${name}'`);
    return packages[name];
  };
}

const asPackage = (definition: ModuleDefinition) => ({ default: definition });

async function problemsOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

const base = defineModule({ name: 'base' });
const dependent = defineModule({ name: 'dependent', dependsOn: [base] });
const configured = defineModule({
  name: 'configured',
  config: z.object({ webhookName: z.string(), silent: z.boolean().default(true) }),
});

describe('loadModules', () => {
  it('sorts modules after their dependencies', async () => {
    const loaded = await loadModules(
      { '@x/dependent': {}, '@x/base': {} },
      importerOf({ '@x/dependent': asPackage(dependent), '@x/base': asPackage(base) }),
    );
    expect(loaded.map((module) => module.packageName)).toEqual(['@x/base', '@x/dependent']);
    expect(loaded[1]?.definition).toBe(dependent);
  });

  it('validates each config section and returns the parsed value', async () => {
    const loaded = await loadModules(
      { '@x/configured': { webhookName: 'Sticky' } },
      importerOf({ '@x/configured': asPackage(configured) }),
    );
    expect(loaded[0]?.config).toEqual({ webhookName: 'Sticky', silent: true });
  });

  it('reports invalid settings with their config path', async () => {
    const problems = await problemsOf(
      loadModules({ '@x/configured': { silent: 'yes' } }, importerOf({ '@x/configured': asPackage(configured) })),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^modules\.@x\/configured\.webhookName: /);
    expect(problems[1]).toMatch(/^modules\.@x\/configured\.silent: /);
  });

  it('rejects settings for a module without a config schema', async () => {
    const problems = await problemsOf(
      loadModules({ '@x/base': { extra: 1 } }, importerOf({ '@x/base': asPackage(base) })),
    );
    expect(problems).toEqual(['modules.@x/base: module "base" takes no settings']);
  });

  it('reports packages that cannot be imported or are not modules', async () => {
    const problems = await problemsOf(
      loadModules({ '@x/missing': {}, '@x/plain': {} }, importerOf({ '@x/plain': { default: 42 } })),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^modules\.@x\/missing: cannot import the package \(Cannot find package/);
    expect(problems[1]).toBe("modules.@x/plain: the package's default export is not a module definition");
  });

  it('reports a dependency that is not loaded', async () => {
    const problems = await problemsOf(
      loadModules({ '@x/dependent': {} }, importerOf({ '@x/dependent': asPackage(dependent) })),
    );
    expect(problems).toEqual(['modules.@x/dependent: depends on module "base", which is not loaded']);
  });

  it('reports dependency cycles', async () => {
    const first = defineModule({ name: 'cycle_a' });
    const second = defineModule({ name: 'cycle_b', dependsOn: [first] });
    first.dependsOn = [second];
    const problems = await problemsOf(
      loadModules(
        { '@x/a': {}, '@x/b': {} },
        importerOf({ '@x/a': asPackage(first), '@x/b': asPackage(second) }),
      ),
    );
    expect(problems).toEqual(['modules: dependency cycle cycle_a -> cycle_b -> cycle_a']);
  });

  it('reports two packages with the same module name', async () => {
    const problems = await problemsOf(
      loadModules({ '@x/one': {}, '@x/two': {} }, importerOf({ '@x/one': asPackage(base), '@x/two': asPackage(base) })),
    );
    expect(problems).toEqual(['modules.@x/two: module name "base" is already used by @x/one']);
  });

  it('reports tables outside the module schema', async () => {
    const other = pgSchema('other');
    const things = other.table('things', { id: text('id') });
    const owner = defineModule({ name: 'owner', db: { schema: { things }, migrations: new URL('file:///unused/') } });
    const problems = await problemsOf(loadModules({ '@x/owner': {} }, importerOf({ '@x/owner': asPackage(owner) })));
    expect(problems).toEqual(['modules.@x/owner: table "other.things" is outside the module\'s schema "owner"']);
  });
});
