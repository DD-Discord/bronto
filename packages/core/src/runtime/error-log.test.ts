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

  it('masks the values Postgres quotes in data exception messages, also in the stack and in causes', () => {
    const rejected = Object.assign(new Error('invalid input syntax for type uuid: "SECRET"'), { code: '22P02', severity: 'ERROR' });
    const serialized = serializeError(new Error('Handler failed', { cause: rejected })) as { message: string; stack: string };
    expect(serialized.message).toContain('invalid input syntax for type uuid: "…"');
    expect(serialized.stack).toContain('invalid input syntax for type uuid: "…"');
    expect(JSON.stringify(serialized)).not.toContain('SECRET');
  });

  it.each([
    ['22P02', 'invalid input syntax for type uuid: "SECRET"', 'invalid input syntax for type uuid: "…"'],
    ['22P02', 'invalid input syntax for type uuid: "a"b SECRET"', 'invalid input syntax for type uuid: "…"'],
    ['22P02', 'invalid input syntax for type uuid: "a\\"SECRET\\""', 'invalid input syntax for type uuid: "…"'],
    ['22P02', 'invalid input syntax for type uuid: "line1\nSECRET"', 'invalid input syntax for type uuid: "…"'],
    ['22P02', 'invalid input value for enum mood: "SECRET"', 'invalid input value for enum mood: "…"'],
    ['22003', 'value "99999999999" is out of range for type integer', 'value "…" is out of range for type integer'],
    ['22008', 'date/time field value out of range: "2026-13-45"', 'date/time field value out of range: "…"'],
    ['22001', 'value too long for type character varying(5)', 'value too long for type character varying(5)'],
    ['22012', 'division by zero', 'division by zero'],
  ])('masks the quoted input of a %s message: %s', (code, raw, masked) => {
    const rejected = Object.assign(new Error(raw), { code, severity: 'ERROR' });
    expect((serializeError(rejected) as { message: string }).message).toBe(masked);
  });

  it('masks unquoted values after the colon of a data exception message', () => {
    const rejected = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021', severity: 'ERROR' });
    expect((serializeError(rejected) as { message: string }).message).toBe('invalid byte sequence for encoding "…": …');
  });

  it('keeps the names Postgres quotes in other errors', () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint "items_pkey"'), {
      code: '23505',
      severity: 'ERROR',
    });
    expect((serializeError(violation) as { message: string }).message).toBe(violation.message);
  });

  it('leaves errors without query values unchanged', () => {
    const error = new Error('plain');
    expect((serializeError(error) as { raw: unknown }).raw).toBe(error);
  });
});
