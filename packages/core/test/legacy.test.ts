import type { Client } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guilds } from '../src/db/schema.js';
import { createModuleRuntimes } from '../src/runtime/context.js';
import { runLegacyImport, type LegacyImporter } from '../src/runtime/legacy.js';
import { captureLog } from '../src/testing/log.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterEach(async () => {
  await t.drop();
});

function runtimeWith(importLegacy?: LegacyImporter) {
  const [runtime] = createModuleRuntimes(
    [{ packageName: '@test/widgets', definition: widgetsModule({ importLegacy }), config: {} }],
    { client: {} as Client, database: t.database, log: captureLog().log },
  );
  return runtime!;
}

const importer: LegacyImporter = async (ctx, path) => {
  await ctx.registerGuild('g9');
  await ctx.forGuild('g9', 'u9').run(async (tx) => {
    await tx.insert(widgetItems).values({ id: 'w1', label: path });
  });
  return [`imported ${path}`];
};

describe('runLegacyImport', () => {
  it('registers guilds and attributes the rows to the given user', async () => {
    const lines = await runLegacyImport({ runtime: runtimeWith(importer), database: t.database, path: 'old', dryRun: false });
    expect(lines).toEqual(['imported old']);
    expect(await t.database.admin.select().from(guilds).where(eq(guilds.id, 'g9'))).toHaveLength(1);
    const [row] = await t.database.admin.select().from(widgetItems);
    expect(row).toMatchObject({ id: 'w1', guildId: 'g9', label: 'old', createdBy: 'u9' });
  });

  it('writes nothing in a dry run', async () => {
    const seen: string[] = [];
    const careful: LegacyImporter = async (ctx) => {
      seen.push(`dry:${ctx.dryRun}`);
      await expect(ctx.registerGuild('g9')).rejects.toThrow('A dry run writes nothing.');
      expect(() => ctx.forGuild('g9')).toThrow('A dry run writes nothing.');
      return ['checked'];
    };
    expect(await runLegacyImport({ runtime: runtimeWith(careful), database: t.database, path: 'old', dryRun: true })).toEqual([
      'checked',
    ]);
    expect(seen).toEqual(['dry:true']);
  });

  it('refuses modules without an importer', async () => {
    await expect(runLegacyImport({ runtime: runtimeWith(), database: t.database, path: 'old', dryRun: false })).rejects.toThrow(
      'Module "widgets" has no legacy importer.',
    );
  });
});
