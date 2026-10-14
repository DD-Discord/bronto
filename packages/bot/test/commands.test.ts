import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guilds, StartupError, type ModuleDefinition, type ModuleImporter } from '@bronto/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClient } from '../../core/test/fake-client.js';
import { widgetsModule } from '../../core/test/fixtures/widgets/module.js';
import { widgetItems } from '../../core/test/fixtures/widgets/schema.js';
import { captureLog } from '../../core/test/log.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from '../../core/test/test-db.js';
import { CliError, runDeleteGuild, runPurge, runStart, type CommandDeps } from '../src/commands.js';

let t: TestDatabase;
let dir: string;

beforeEach(async () => {
  t = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'bronto-cli-'));
});

afterEach(async () => {
  await t.drop();
});

async function writeConfig(modules: string[], appUrl: string = t.appUrl): Promise<string> {
  const lines = [
    'discord:',
    '  token: ${DISCORD_TOKEN}',
    'database:',
    `  appUrl: "${appUrl}"`,
    `  adminUrl: "${t.adminUrl}"`,
  ];
  if (modules.length > 0) lines.push('modules:', ...modules.map((name) => `  "${name}": {}`));
  const path = join(dir, 'config.yaml');
  await writeFile(path, lines.join('\n'));
  return path;
}

function commandDeps(definitions: Record<string, ModuleDefinition>) {
  const client = new FakeClient();
  const importer: ModuleImporter = async (name) => {
    const definition = definitions[name];
    if (definition === undefined) throw new Error(`Cannot find package '${name}'`);
    return { default: definition };
  };
  const deps: CommandDeps = {
    importer,
    env: { DISCORD_TOKEN: 'token-1' },
    log: captureLog().log,
    createClient: () => client.asClient(),
  };
  return { deps, client };
}

async function schemaExists(name: string): Promise<boolean> {
  const { rows } = await t.database.adminPool.query('select 1 from pg_namespace where nspname = $1', [name]);
  return rows.length === 1;
}

describe('runStart', () => {
  it('logs in and disconnects on stop', async () => {
    const { deps, client } = commandDeps({ '@test/widgets': widgetsModule() });
    const running = await runStart(await writeConfig(['@test/widgets']), deps);
    expect(client.loggedInWith).toBe('token-1');
    await running.stop();
    expect(client.destroyed).toBe(true);
  });

  it('refuses to start when the database is unsafe', async () => {
    const { deps, client } = commandDeps({});
    await expect(runStart(await writeConfig([], t.adminUrl), deps)).rejects.toBeInstanceOf(StartupError);
    expect(client.loggedInWith).toBeNull();
  });
});

describe('runPurge', () => {
  it('refuses to purge a module that is still loaded', async () => {
    await setUpSchema(t.database);
    const { deps } = commandDeps({ '@test/widgets': widgetsModule() });
    await expect(runPurge(await writeConfig(['@test/widgets']), 'widgets', deps)).rejects.toThrow(
      new CliError('Module "widgets" is still loaded; remove it from config.yaml first.'),
    );
    expect(await schemaExists('widgets')).toBe(true);
  });

  it('drops the schema of a module that is no longer loaded', async () => {
    await setUpSchema(t.database);
    const { deps } = commandDeps({});
    await runPurge(await writeConfig([]), 'widgets', deps);
    expect(await schemaExists('widgets')).toBe(false);
  });

  it('reports a missing config file', async () => {
    const { deps } = commandDeps({});
    await expect(runPurge(join(dir, 'missing.yaml'), 'widgets', deps)).rejects.toThrow(
      `Config file not found: ${join(dir, 'missing.yaml')}`,
    );
  });
});

describe('runDeleteGuild', () => {
  it('runs module cleanup and deletes the guild without logging in', async () => {
    await setUpSchema(t.database);
    await t.database.admin.insert(guilds).values({ id: 'g1' });
    await t.database.admin.insert(widgetItems).values({ id: 'w1', guildId: 'g1', label: 'x' });
    const cleaned: string[] = [];
    const module = widgetsModule({
      hooks: {
        deleteGuildData: (_ctx, guildId) => {
          cleaned.push(guildId);
        },
      },
    });
    const { deps, client } = commandDeps({ '@test/widgets': module });
    await runDeleteGuild(await writeConfig(['@test/widgets']), 'g1', deps);
    expect(cleaned).toEqual(['g1']);
    expect(await t.database.admin.select().from(guilds).where(eq(guilds.id, 'g1'))).toEqual([]);
    expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'w1'))).toEqual([]);
    expect(client.restToken).toBe('token-1');
    expect(client.loggedInWith).toBeNull();
  });
});
