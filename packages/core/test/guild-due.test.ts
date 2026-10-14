import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isGuildDue, markGuildLeft, upsertGuild } from '../src/db/guilds.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-14T12:00:00Z');
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterAll(async () => {
  await t.drop();
});

describe('isGuildDue', () => {
  it('is true only once the grace period has passed', async () => {
    for (const id of ['long-gone', 'just-left', 'present']) await upsertGuild(t.database.admin, id);
    await markGuildLeft(t.database.admin, 'long-gone', new Date(NOW.getTime() - 31 * DAY));
    await markGuildLeft(t.database.admin, 'just-left', new Date(NOW.getTime() - DAY));
    expect(await isGuildDue(t.database.admin, 'long-gone', NOW)).toBe(true);
    expect(await isGuildDue(t.database.admin, 'just-left', NOW)).toBe(false);
    expect(await isGuildDue(t.database.admin, 'present', NOW)).toBe(false);
    expect(await isGuildDue(t.database.admin, 'unknown', NOW)).toBe(false);
  });
});
