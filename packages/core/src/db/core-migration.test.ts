import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const folder = new URL('../../drizzle/', import.meta.url);

async function migrationSql(): Promise<string> {
  const files = (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort();
  const contents = await Promise.all(files.map((file) => readFile(new URL(file, folder), 'utf8')));
  return contents.join('\n');
}

describe('core migrations', () => {
  it('create the guild tables with FK, RLS and policy', async () => {
    const sql = await migrationSql();
    expect(sql).toContain('CREATE SCHEMA "core"');
    expect(sql).toContain('CREATE TABLE "core"."guilds"');
    expect(sql).toContain('CREATE TABLE "core"."guild_modules"');
    expect(sql).toContain('ALTER TABLE "core"."guild_modules" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REFERENCES "core"."guilds"("id") ON DELETE cascade');
    expect(sql).toContain('CREATE POLICY "guild_modules_guild_isolation"');
    expect(sql).not.toContain('ALTER TABLE "core"."guilds" ENABLE ROW LEVEL SECURITY');
  });
});
