import { describe, expect, it } from 'vitest';
import { substituteEnv } from './env.js';
import { ConfigError } from './errors.js';

describe('substituteEnv', () => {
  it('replaces placeholders in nested strings and arrays', () => {
    expect(substituteEnv({ a: { b: 'x-${FOO}-y' }, list: ['${FOO}'] }, { FOO: 'bar' })).toEqual({
      a: { b: 'x-bar-y' },
      list: ['bar'],
    });
  });

  it('leaves non-string values untouched', () => {
    expect(substituteEnv({ n: 1, b: true, z: null }, {})).toEqual({ n: 1, b: true, z: null });
  });

  it('uses the default when the variable is unset or empty', () => {
    expect(substituteEnv(['${A:-one}', '${B:-two}', '${C:-}'], { B: '' })).toEqual(['one', 'two', '']);
  });

  it('keeps an empty value for a placeholder without default', () => {
    expect(substituteEnv('${A}', { A: '' })).toBe('');
  });

  it('treats $$ as a literal dollar sign', () => {
    expect(substituteEnv('pa$$word $${NOT_A_VAR}', {})).toBe('pa$word ${NOT_A_VAR}');
  });

  it('does not re-interpret substituted values', () => {
    expect(substituteEnv('${A}', { A: '${B}', B: 'nope' })).toBe('${B}');
  });

  it('reports every unset variable with its config path', () => {
    let caught: unknown;
    try {
      substituteEnv(
        { discord: { token: '${DISCORD_TOKEN}' }, modules: { '@bronto/sticky': { hooks: ['${HOOK}'] } } },
        {},
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).problems).toEqual([
      'discord.token: DISCORD_TOKEN is not set',
      'modules.@bronto/sticky.hooks[0]: HOOK is not set',
    ]);
  });
});
