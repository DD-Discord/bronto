import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Both connection pools: `admin` owns the schema and bypasses RLS; `app` is used by handlers and is subject to RLS. */
export interface Database {
  admin: Db;
  app: Db;
  adminPool: pg.Pool;
  appPool: pg.Pool;
  /** Postgres role of the app connection, taken from its URL. */
  appRole: string;
  end(): Promise<void>;
}

export function createDatabase({ adminUrl, appUrl }: { adminUrl: string; appUrl: string }): Database {
  const adminPool = new pg.Pool({ connectionString: adminUrl });
  const appPool = new pg.Pool({ connectionString: appUrl });
  return {
    admin: drizzle({ client: adminPool }),
    app: drizzle({ client: appPool }),
    adminPool,
    appPool,
    appRole: decodeURIComponent(new URL(appUrl).username),
    async end() {
      await Promise.all([adminPool.end(), appPool.end()]);
    },
  };
}
