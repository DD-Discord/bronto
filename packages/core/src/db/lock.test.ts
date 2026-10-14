import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './database.js';
import { withMigrationLock } from './lock.js';

function fakeDatabase(failOn: RegExp | null) {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string) => {
      if (failOn?.test(text)) throw new Error(`failed: ${text}`);
      return { rows: [] };
    }),
    release,
  } as unknown as pg.PoolClient;
  const database = { adminPool: { connect: async () => client } } as unknown as Database;
  return { database, release };
}

describe('withMigrationLock', () => {
  it('returns the connection to the pool after unlocking', async () => {
    const { database, release } = fakeDatabase(null);
    await expect(withMigrationLock(database, async () => 'done')).resolves.toBe('done');
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });

  it('destroys the connection when unlocking fails', async () => {
    const { database, release } = fakeDatabase(/unlock/);
    await expect(withMigrationLock(database, async () => 'done')).rejects.toThrow(/unlock/);
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });

  it('keeps the original error when both the work and unlocking fail', async () => {
    const { database, release } = fakeDatabase(/unlock/);
    await expect(
      withMigrationLock(database, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });

  it('destroys the connection when locking fails', async () => {
    const { database, release } = fakeDatabase(/advisory_lock/);
    await expect(withMigrationLock(database, async () => 'done')).rejects.toThrow(/advisory_lock/);
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });
});
