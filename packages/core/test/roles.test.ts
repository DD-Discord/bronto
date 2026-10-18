import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkRoles } from '../src/db/checks.js';
import { createDatabase } from '../src/db/database.js';
import { createTestDatabase, type TestDatabase } from './test-db.js';

let t: TestDatabase;
let admin: string;
const member = `member_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

beforeAll(async () => {
  t = await createTestDatabase();
  const { rows } = await t.database.adminPool.query<{ admin: string }>('select current_user as "admin"');
  admin = rows[0]!.admin;
  await t.database.adminPool.query(`create role ${member} login password 'pw'; grant "${admin}" to ${member}`);
});

afterAll(async () => {
  await t.database.adminPool.query(`drop role ${member}`);
  await t.drop();
});

describe('checkRoles', () => {
  it('accepts a separate app role', async () => {
    expect(await checkRoles(t.database, [])).toEqual([]);
  });

  it('flags an app role that is a member of the admin role', async () => {
    const url = new URL(t.appUrl);
    url.username = member;
    url.password = 'pw';
    const database = createDatabase({ adminUrl: t.adminUrl, appUrl: url.toString() });
    try {
      expect(await checkRoles(database, [])).toEqual([
        `App role "${member}" is a member of the admin role "${admin}", so it bypasses RLS on the admin role's tables.`,
      ]);
    } finally {
      await database.end();
    }
  });
});
