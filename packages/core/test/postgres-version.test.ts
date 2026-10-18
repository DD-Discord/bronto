import { describe, expect, it } from 'vitest';
import { assertPostgresVersion } from '../src/db/prepare.js';

describe('assertPostgresVersion', () => {
  it('accepts Postgres 16 and newer', () => {
    expect(() => assertPostgresVersion(160000)).not.toThrow();
    expect(() => assertPostgresVersion(170004)).not.toThrow();
  });

  it('rejects older versions and names the one found', () => {
    expect(() => assertPostgresVersion(150014)).toThrow('Postgres 16 or newer is required (found 15.14).');
    expect(() => assertPostgresVersion(140000)).toThrow('(found 14.0)');
  });
});
