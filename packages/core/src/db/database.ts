import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What the schema helpers need from a pool or a single checked-out client. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Both connection pools: `admin` owns the schema and bypasses RLS; `app` is used by handlers and is subject to RLS. */
export interface Database {
  admin: Db;
  app: Db;
  adminPool: pg.Pool;
  appPool: pg.Pool;
  /** Postgres role of the app connection, taken from its URL. */
  appRole: string;
  /** Password from the app URL, used to create or update the app role; undefined when the URL has none. */
  appPassword: string | undefined;
  end(): Promise<void>;
}

export function createDatabase({ adminUrl, appUrl }: { adminUrl: string; appUrl: string }): Database {
  // Grants and role checks need the app role's name, so it cannot come from PGUSER or other defaults.
  const { username, password } = new URL(appUrl);
  const appRole = decodeURIComponent(username);
  if (appRole === '') {
    throw new Error('The app database URL has no user name; it must name the app role, e.g. postgres://bot_app:...@host/db.');
  }
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  return {
    admin: drizzle({ client: adminPool }),
    app: drizzle({ client: appPool }),
    adminPool,
    appPool,
    appRole,
    appPassword: password === '' ? undefined : decodeURIComponent(password),
    async end() {
      await Promise.all([adminPool.end(), appPool.end()]);
    },
  };
}
