import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkRoles, checkSchemas, formatSchemaProblems } from '../src/db/checks.js';
import { createDatabase } from '../src/db/database.js';
import { globalTableNames } from '../src/db/registry.js';
import * as coreSchema from '../src/db/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;
const coreExpectation = () => ({ schema: 'core', globalTables: globalTableNames(coreSchema) });

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterAll(async () => {
  await t.drop();
});

describe('checkSchemas', () => {
  it('accepts tables built with guildTable and declared globals', async () => {
    expect(await checkSchemas(t.database, [coreExpectation(), { schema: 'widgets', globalTables: [] }])).toEqual([]);
  });

  it('flags a global table that was not declared global', async () => {
    const problems = await checkSchemas(t.database, [{ schema: 'core', globalTables: [] }]);
    expect(problems).toEqual([
      { schema: 'core', table: 'guilds', problem: 'missing-rls' },
      { schema: 'core', table: 'guilds', problem: 'missing-policy' },
      { schema: 'core', table: 'guilds', problem: 'missing-guild-fk' },
    ]);
  });

  it('flags a table created without guildTable', async () => {
    await t.database.adminPool.query('create table widgets.bad (id text primary key)');
    try {
      const problems = await checkSchemas(t.database, [{ schema: 'widgets', globalTables: [] }]);
      expect(problems).toEqual([
        { schema: 'widgets', table: 'bad', problem: 'missing-rls' },
        { schema: 'widgets', table: 'bad', problem: 'missing-policy' },
        { schema: 'widgets', table: 'bad', problem: 'missing-guild-fk' },
      ]);
      expect(formatSchemaProblems(problems)).toBe(
        'widgets.bad: missing-rls\nwidgets.bad: missing-policy\nwidgets.bad: missing-guild-fk',
      );
    } finally {
      await t.database.adminPool.query('drop table widgets.bad');
    }
  });

  it('flags RLS without a policy', async () => {
    await t.database.adminPool.query(`
      create table widgets.half (id text primary key, guild_id text not null references core.guilds(id) on delete cascade);
      alter table widgets.half enable row level security;
    `);
    try {
      expect(await checkSchemas(t.database, [{ schema: 'widgets', globalTables: [] }])).toEqual([
        { schema: 'widgets', table: 'half', problem: 'missing-policy' },
      ]);
    } finally {
      await t.database.adminPool.query('drop table widgets.half');
    }
  });

  it('flags a guild foreign key that does not cascade', async () => {
    await t.database.adminPool.query(`
      create table widgets.stuck (id text primary key, guild_id text not null references core.guilds(id));
      alter table widgets.stuck enable row level security;
      create policy stuck_guild_isolation on widgets.stuck using (guild_id = current_setting('app.guild_id', true));
    `);
    try {
      expect(await checkSchemas(t.database, [{ schema: 'widgets', globalTables: [] }])).toEqual([
        { schema: 'widgets', table: 'stuck', problem: 'guild-fk-not-cascade' },
      ]);
    } finally {
      await t.database.adminPool.query('drop table widgets.stuck');
    }
  });

  it('flags views and materialized views, which bypass RLS', async () => {
    await t.database.adminPool.query(`
      create view widgets.all_items as select * from widgets.items;
      create materialized view widgets.item_counts as select guild_id, count(*) from widgets.items group by guild_id;
    `);
    try {
      expect(await checkSchemas(t.database, [{ schema: 'widgets', globalTables: [] }])).toEqual([
        { schema: 'widgets', table: 'all_items', problem: 'view-bypasses-rls' },
        { schema: 'widgets', table: 'item_counts', problem: 'view-bypasses-rls' },
      ]);
    } finally {
      await t.database.adminPool.query('drop view widgets.all_items; drop materialized view widgets.item_counts');
    }
  });
});

describe('checkRoles', () => {
  async function problemsForRole(role: string, attributes: string): Promise<string[]> {
    await t.database.adminPool.query(`create role ${role} ${attributes}`);
    const appUrl = new URL(t.adminUrl);
    appUrl.username = role;
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: appUrl.toString() });
    try {
      return await checkRoles(database);
    } finally {
      await database.end();
      await t.database.adminPool.query(`drop role ${role}`);
    }
  }

  const uniqueRole = () => `r_${randomUUID().replaceAll('-', '')}`;

  it('accepts a plain app role', async () => {
    expect(await checkRoles(t.database)).toEqual([]);
  });

  it('flags an app role that is the admin role', async () => {
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: t.adminUrl });
    try {
      // The container's admin is the bootstrap superuser, which also has BYPASSRLS.
      expect(await checkRoles(database)).toEqual([
        expect.stringMatching(/is the admin role/),
        expect.stringMatching(/is a superuser/),
        expect.stringMatching(/BYPASSRLS/),
      ]);
    } finally {
      await database.end();
    }
  });

  it('flags a superuser app role', async () => {
    const problems = await problemsForRole(uniqueRole(), 'superuser');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/is a superuser/);
  });

  it('flags an app role with BYPASSRLS', async () => {
    const problems = await problemsForRole(uniqueRole(), 'bypassrls');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/BYPASSRLS/);
  });

  it('flags a missing app role', async () => {
    const appUrl = new URL(t.adminUrl);
    appUrl.username = uniqueRole();
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: appUrl.toString() });
    try {
      expect(await checkRoles(database)).toEqual([expect.stringMatching(/does not exist/)]);
    } finally {
      await database.end();
    }
  });
});
