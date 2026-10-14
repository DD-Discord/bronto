import type pg from 'pg';
import { MIGRATION_LOCK_KEY } from './constants.js';
import type { Database } from './database.js';

/**
 * Runs `fn` on one admin connection that holds the migration advisory lock, so concurrent starts and purges run
 * their schema changes one after another. A connection whose lock state is unknown is destroyed, not pooled.
 */
export async function withMigrationLock<T>(database: Database, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database.adminPool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  } catch (error) {
    client.release(asError(error));
    throw error;
  }
  let result: T;
  try {
    result = await fn(client);
  } catch (error) {
    // The original error matters more; a failed unlock still destroys the connection, which ends the lock.
    await unlockAndRelease(client).catch(() => undefined);
    throw error;
  }
  await unlockAndRelease(client);
  return result;
}

async function unlockAndRelease(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  } catch (error) {
    client.release(asError(error));
    throw error;
  }
  client.release();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
