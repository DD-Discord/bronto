import { describe, expect, it } from 'vitest';
import { serializeError } from './error-log.js';

describe('serializeError', () => {
  it('drops Postgres fields that quote row values and keeps the original error intact', () => {
    const error = Object.assign(new Error('duplicate key value violates unique constraint "items_pkey"'), {
      code: '23505',
      detail: 'Key (id)=(SECRET) already exists.',
    });
    const serialized = serializeError(error) as Record<string, unknown>;
    expect(serialized).toMatchObject({ code: '23505', message: error.message });
    expect(serialized).not.toHaveProperty('detail');
    expect(error.detail).toBe('Key (id)=(SECRET) already exists.');
  });

  it('leaves errors without query values unchanged', () => {
    const error = new Error('plain');
    expect((serializeError(error) as { raw: unknown }).raw).toBe(error);
  });
});
