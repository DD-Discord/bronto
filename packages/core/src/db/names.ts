const MODULE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED = new Set(['migrations', 'public', 'information_schema']);

/** Module names become Postgres schema and table names, so only safe identifiers are allowed. */
export function assertModuleName(name: string): void {
  if (!MODULE_NAME.test(name) || RESERVED.has(name) || name.startsWith('pg_')) {
    throw new Error(`Invalid module name "${name}": use lowercase letters, digits and "_", starting with a letter.`);
  }
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
