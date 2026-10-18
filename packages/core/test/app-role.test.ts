import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAppRole } from '../src/db/app-role.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { moduleRoleName } from '../src/db/module-roles.js';
import { prepareDatabase } from '../src/db/prepare.js';
import { asModuleRole, createTestDatabase, schemaExpectations, widgetsTarget, type TestDatabase } from './test-db.js';

let t: TestDatabase;
const roles: string[] = [];

function uniqueRole(prefix: string): string {
  const role = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  roles.push(role);
  return role;
}

function urlFor(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function withDatabase<T>(appUrl: string, fn: (database: Database) => Promise<T>, adminUrl = t.adminUrl): Promise<T> {
  const database = createDatabase({ adminUrl, appUrl });
  try {
    return await fn(database);
  } finally {
    await database.end();
  }
}

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  for (const role of roles) await t.database.adminPool.query(`drop role if exists "${role}"`);
  await t.drop();
});

describe('ensureAppRole', () => {
  it('creates a missing app role that can log in and does not bypass RLS', async () => {
    const role = uniqueRole('app');
    const appUrl = urlFor(t.adminUrl, role, 'first pass/word');
    await withDatabase(appUrl, (database) => ensureAppRole(t.database.adminPool, database));
    expect(await canConnect(appUrl)).toBe(true);
    const { rows } = await t.database.adminPool.query(
      'select rolsuper as "super", rolbypassrls as "bypass", rolcreaterole as "createRole" from pg_roles where rolname = $1',
      [role],
    );
    expect(rows).toEqual([{ super: false, bypass: false, createRole: false }]);
  });

  it('sets a changed password on an existing app role', async () => {
    const role = uniqueRole('app');
    await t.database.adminPool.query(`create role "${role}" login password 'old'`);
    const appUrl = urlFor(t.adminUrl, role, 'new');
    await withDatabase(appUrl, (database) => ensureAppRole(t.database.adminPool, database));
    expect(await canConnect(appUrl)).toBe(true);
    expect(await canConnect(urlFor(t.adminUrl, role, 'old'))).toBe(false);
  });

  it('leaves the admin role alone when the app URL names it', async () => {
    const admin = uniqueRole('admin');
    await t.database.adminPool.query(`create role "${admin}" login createrole password 'admin-pw'`);
    const adminUrl = urlFor(t.adminUrl, admin, 'admin-pw');
    await withDatabase(
      urlFor(t.adminUrl, admin, 'other'),
      async (database) => {
        await ensureAppRole(database.adminPool, database);
      },
      adminUrl,
    );
    expect(await canConnect(adminUrl)).toBe(true);
  });

  it('leaves a missing role for checkRoles to report when the admin may not create roles', async () => {
    const admin = uniqueRole('admin');
    await t.database.adminPool.query(`create role "${admin}" login password 'admin-pw'`);
    const role = uniqueRole('app');
    await withDatabase(
      urlFor(t.adminUrl, role, 'pw'),
      (database) => ensureAppRole(database.adminPool, database),
      urlFor(t.adminUrl, admin, 'admin-pw'),
    );
    const { rows } = await t.database.adminPool.query('select 1 from pg_roles where rolname = $1', [role]);
    expect(rows).toEqual([]);
  });

  it('runs as part of prepareDatabase', async () => {
    const other = await createTestDatabase();
    const role = uniqueRole('app');
    try {
      const appUrl = urlFor(other.adminUrl, role, 'pw');
      await withDatabase(
        appUrl,
        async (database) => {
          expect(await prepareDatabase(database, { modules: [widgetsTarget], expectations: schemaExpectations() })).toEqual(
            [],
          );
          const widgetsRole = moduleRoleName(role, 'widgets');
          roles.push(widgetsRole);
          await expect(
            asModuleRole(database, 'widgets', (tx) => tx.execute(sql`select count(*) from widgets.items`)),
          ).resolves.toBeDefined();
        },
        other.adminUrl,
      );
    } finally {
      await other.drop();
    }
  });
});
