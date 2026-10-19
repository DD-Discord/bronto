import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from './duration.js';
import { UserError } from './errors.js';

describe('parseDuration', () => {
  it.each([
    ['90s', 90_000],
    ['1h 30m', 5_400_000],
    ['1h30m', 5_400_000],
    ['14d', 1_209_600_000],
    ['2w', 1_209_600_000],
    ['0s', 0],
    ['1H 30M', 5_400_000],
  ])('reads %s', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['90', '', '1x', '30m 1h', '1h 1h', '-5m', '1.5h'])('rejects %j', (text) => {
    expect(() => parseDuration(text)).toThrow(UserError);
    expect(() => parseDuration(text)).toThrow('Enter a duration like `90s`, `15m`, `1h 30m` or `14d`.');
  });
});

describe('formatDuration', () => {
  it.each([
    [1_209_600_000, '2w'],
    [864_000_000, '10d'],
    [5_400_000, '1h 30m'],
    [0, '0s'],
    [90_000, '1m 30s'],
  ])('formats %d as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it('round-trips whole seconds', () => {
    for (const ms of [1000, 59_000, 3_661_000, 604_801_000, 86_400_000]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });
});
