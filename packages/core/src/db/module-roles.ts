import type { Queryable } from './database.js';
import { assertModuleName, quoteIdent } from './names.js';

const MAX_IDENTIFIER_BYTES = 63;
const INSUFFICIENT_PRIVILEGE = '42501';
// Concurrent starts against one cluster race on the shared role catalogs: create role reports duplicate_object or
// unique_violation, and a grant whose membership row another session just wrote reports unique_violation.
const DUPLICATE = new Set(['42710', '23505']);

/** Postgres role a module's database work runs as. */
export function moduleRoleName(appRole: string, module: string): string {
  assertModuleName(module);
  const name = `${appRole}_${module}`;
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Module role "${name}" is longer than 63 bytes; use a shorter app role or module name.`);
  }
  return name;
}

/**
 * Creates missing module roles and lets the app role SET (not inherit) them. Safe to run concurrently. An admin that
 * may not create roles or grant them leaves them missing, and the remaining roles are still tried; checkRoles reports
 * the missing ones.
 */
export async function ensureModuleRoles(admin: Queryable, appRole: string, modules: string[]): Promise<void> {
  for (const module of modules) {
    const role = moduleRoleName(appRole, module);
    const { rows } = await admin.query<{ exists: boolean; granted: boolean }>(
      `select exists (select 1 from pg_roles where rolname = $1) as "exists",
              exists (select 1 from pg_auth_members m
                       where m.roleid = (select oid from pg_roles where rolname = $1)
                         and m.member = (select oid from pg_roles where rolname = $2)
                         and m.set_option and not m.inherit_option) as "granted"`,
      [role, appRole],
    );
    const state = rows[0]!;
    if (state.granted) continue;
    if (!state.exists && !(await runTolerant(admin, `create role ${quoteIdent(role)} nologin`))) continue;
    // INHERIT FALSE: the app role gets the module's privileges only after SET ROLE inside ScopedDb.run.
    const grant = `grant ${quoteIdent(role)} to ${quoteIdent(appRole)} with inherit false, set true`;
    if (!(await runTolerant(admin, grant))) continue;
  }
}

/** Runs `statement`, ignoring a concurrent duplicate; false when the admin lacks the privilege. */
async function runTolerant(admin: Queryable, statement: string): Promise<boolean> {
  try {
    await admin.query(statement);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return false;
    if (code === undefined || !DUPLICATE.has(code)) throw error;
    return true;
  }
}
