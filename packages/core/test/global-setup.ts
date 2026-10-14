import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgRootUrl: string;
  }
}

/** Starts one Postgres for the whole run. Roles are cluster-wide, so bot_app is created here once. */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  await client.query(`create role bot_app login password 'bot_app'`);
  await client.end();
  project.provide('pgRootUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
