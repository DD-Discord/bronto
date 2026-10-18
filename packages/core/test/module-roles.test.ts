import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRoles } from '../src/db/checks.js';
import { createDatabase } from '../src/db/database.js';
import { ensureModuleRoles, moduleRoleName } from '../src/db/module-roles.js';
import { guilds } from '../src/db/schema.js';
import { createScopedDb } from '../src/db/scoped.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, errorText, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;
const widgetsRole = () => moduleRoleName(t.database.appRole, 'widgets');

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await t.database.admin.insert(guilds).values({ id: 'g1' });
});

afterAll(async () => {
  await t.drop();
});

describe('module roles', () => {
  it('names a module role after the app role', () => {
    expect(moduleRoleName('bot_app', 'sticky')).toBe('bot_app_sticky');
    expect(() => moduleRoleName('a'.repeat(40), 'b'.repeat(30))).toThrow('longer than 63');
  });

  it('lets a module role use its own tables within one guild', async () => {
    const db = createScopedDb(t.database.app, 'g1', widgetsRole());
    await db.run((tx) => tx.insert(widgetItems).values({ id: 'r1', label: 'R' }));
    expect(await db.run((tx) => tx.select().from(widgetItems))).toHaveLength(1);
  });

  it('keeps the plain app role away from module tables', async () => {
    const error = await createScopedDb(t.database.app, 'g1')
      .run((tx) => tx.select().from(widgetItems))
      .catch((e: unknown) => e);
    expect(errorText(error)).toMatch(/permission denied/);
  });

  it('keeps a module role away from core tables', async () => {
    const error = await createScopedDb(t.database.app, 'g1', widgetsRole())
      .run((tx) => tx.select().from(guilds))
      .catch((e: unknown) => e);
    expect(errorText(error)).toMatch(/permission denied/);
  });

  it('keeps the role when switching guild', async () => {
    await t.database.admin.insert(guilds).values({ id: 'g2' }).onConflictDoNothing();
    const db = createScopedDb(t.database.app, 'g1', widgetsRole()).forGuild('g2');
    await db.run((tx) => tx.insert(widgetItems).values({ id: 'r2', label: 'R' }));
    expect(await db.run((tx) => tx.select().from(widgetItems))).toMatchObject([{ id: 'r2', guildId: 'g2' }]);
  });

  it('leaves the connection as the app role after a transaction', async () => {
    // One connection, so the check below runs on the connection the transaction used.
    const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
    try {
      await createScopedDb(drizzle({ client: pool }), 'g1', widgetsRole()).run((tx) => tx.execute(sql`select 1`));
      const { rows } = await pool.query<{ user: string }>('select current_user as "user"');
      expect(rows[0]!.user).toBe(t.database.appRole);
    } finally {
      await pool.end();
    }
  });

  it('leaves the connection as the app role after a transaction that rolls back', async () => {
    const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
    try {
      const failed = createScopedDb(drizzle({ client: pool }), 'g1', widgetsRole()).run(async (tx) => {
        await tx.execute(sql`select 1`);
        throw new Error('boom');
      });
      await expect(failed).rejects.toThrow('boom');
      const { rows } = await pool.query<{ user: string }>('select current_user as "user"');
      expect(rows[0]!.user).toBe(t.database.appRole);
    } finally {
      await pool.end();
    }
  });

  it('accepts the module roles it created', async () => {
    expect(await checkRoles(t.database, ['widgets'])).toEqual([]);
  });

  it('flags a missing module role', async () => {
    expect(await checkRoles(t.database, ['nowhere'])).toEqual([
      `Module role "${moduleRoleName(t.database.appRole, 'nowhere')}" does not exist.`,
    ]);
  });

  it('flags a module role with BYPASSRLS', async () => {
    // A role of its own: module roles are cluster-wide, and other test files use the widgets role meanwhile.
    const appRole = `r_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const role = moduleRoleName(appRole, 'widgets');
    await t.database.adminPool.query(`create role "${appRole}" login`);
    const appUrl = new URL(t.appUrl);
    appUrl.username = appRole;
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: appUrl.toString() });
    try {
      await ensureModuleRoles(t.database.adminPool, appRole, ['widgets']);
      await t.database.adminPool.query(`alter role "${role}" bypassrls`);
      expect(await checkRoles(database, ['widgets'])).toEqual([`Module role "${role}" has BYPASSRLS.`]);
    } finally {
      await database.end();
      await t.database.adminPool.query(`drop role if exists "${role}"; drop role "${appRole}"`);
    }
  });

  it('flags a module role the app role cannot switch to', async () => {
    const appRole = `r_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const role = moduleRoleName(appRole, 'widgets');
    await t.database.adminPool.query(`create role "${appRole}" login; create role "${role}" nologin`);
    const appUrl = new URL(t.appUrl);
    appUrl.username = appRole;
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: appUrl.toString() });
    try {
      expect(await checkRoles(database, ['widgets'])).toEqual([
        `App role "${appRole}" cannot switch to module role "${role}".`,
      ]);
    } finally {
      await database.end();
      await t.database.adminPool.query(`drop role "${role}"; drop role "${appRole}"`);
    }
  });

  it('flags an app role that inherits a module role', async () => {
    const appRole = `r_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const role = moduleRoleName(appRole, 'widgets');
    // A plain grant, as an operator might write by hand, inherits by default.
    await t.database.adminPool.query(
      `create role "${appRole}" login; create role "${role}" nologin; grant "${role}" to "${appRole}"`,
    );
    const appUrl = new URL(t.appUrl);
    appUrl.username = appRole;
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: appUrl.toString() });
    try {
      expect(await checkRoles(database, ['widgets'])).toEqual([
        `App role "${appRole}" inherits module role "${role}"; grant it WITH INHERIT FALSE.`,
      ]);
    } finally {
      await database.end();
      await t.database.adminPool.query(`drop role "${role}"; drop role "${appRole}"`);
    }
  });

  it('creates the same roles from two databases at once', async () => {
    const [a, b] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      await Promise.all([setUpSchema(a.database), setUpSchema(b.database)]);
      expect(await checkRoles(a.database, ['widgets'])).toEqual([]);
    } finally {
      await Promise.all([a.drop(), b.drop()]);
    }
  });
});
