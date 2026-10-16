import type pg from 'pg';
import type { Database, Queryable } from './database.js';

// invalid_authorization_specification (e.g. unknown role) and invalid_password.
const LOGIN_REFUSED = new Set(['28000', '28P01']);
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Creates the app role, or sets its password, when the app URL cannot log in, so a fresh Postgres needs no init
 * script. Leaves roles alone when the app URL names the admin role or the admin may not manage the role; checkRoles
 * reports what is still wrong.
 */
export async function ensureAppRole(admin: Queryable, database: Database): Promise<void> {
  if (await canLogIn(database.appPool)) return;
  const { rows } = await admin.query<{ exists: boolean; isAdmin: boolean }>(
    `select exists (select 1 from pg_roles where rolname = $1) as "exists", current_user = $1 as "isAdmin"`,
    [database.appRole],
  );
  const state = rows[0]!;
  if (state.isAdmin) return;
  const verb = state.exists ? 'alter' : 'create';
  const password = database.appPassword === undefined ? '' : ' password %L';
  // Role statements take no bind parameters; format() quotes the name and password on the server.
  const { rows: statement } = await admin.query<{ sql: string }>(
    `select format('${verb} role %I with login${password}', $1::text, $2::text) as "sql"`,
    [database.appRole, database.appPassword ?? null],
  );
  try {
    await admin.query(statement[0]!.sql);
  } catch (error) {
    if ((error as { code?: string }).code !== INSUFFICIENT_PRIVILEGE) throw error;
  }
}

async function canLogIn(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch (error) {
    if (LOGIN_REFUSED.has((error as { code?: string }).code ?? '')) return false;
    throw error;
  }
}
