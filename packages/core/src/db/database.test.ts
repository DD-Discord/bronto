import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';

describe('createDatabase', () => {
  it('requires a user name in the app URL', () => {
    expect(() =>
      createDatabase({ adminUrl: 'postgres://admin:pw@db:5432/bronto', appUrl: 'postgres://db:5432/bronto' }),
    ).toThrow(/app database URL has no user name/);
  });
});
