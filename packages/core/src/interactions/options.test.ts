import { ApplicationCommandOptionType, ChannelType } from 'discord.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { assertDescription, assertName, opt, optionToJson, readOptions } from './options.js';

const source = (values: Record<string, unknown>) => ({
  get: (name: string) => {
    const value = values[name];
    if (value === undefined) return null;
    return typeof value === 'object' ? { channel: value, role: value, user: value, attachment: value } : { value };
  },
});

describe('opt', () => {
  it('builds option JSON with Discord field names', () => {
    expect(optionToJson('debounce', opt.integer({ description: 'Delay', min: 0, max: 60 }))).toEqual({
      type: ApplicationCommandOptionType.Integer,
      name: 'debounce',
      description: 'Delay',
      required: false,
      min_value: 0,
      max_value: 60,
    });
    expect(
      optionToJson('where', opt.channel({ description: 'Channel', required: true, channelTypes: [ChannelType.GuildText] })),
    ).toEqual({
      type: ApplicationCommandOptionType.Channel,
      name: 'where',
      description: 'Channel',
      required: true,
      channel_types: [ChannelType.GuildText],
    });
    expect(optionToJson('q', opt.string({ description: 'Query', autocomplete: () => [] }), true)).toMatchObject({
      required: true,
      autocomplete: true,
    });
  });

  it('rejects choices together with autocomplete', () => {
    expect(() =>
      opt.string({ description: 'x', choices: [{ name: 'a', value: 'a' }], autocomplete: () => [] }),
    ).toThrow(/either choices or autocomplete/);
  });

  it('types required options as values and optional ones as nullable', () => {
    const options = {
      channel: opt.channel({ description: 'c', required: true }),
      debounce: opt.integer({ description: 'd' }),
    };
    const values = readOptions(options, source({ channel: { id: 'c1' } }));
    expectTypeOf(values.debounce).toEqualTypeOf<number | null>();
    expect(values).toEqual({ channel: { id: 'c1' }, debounce: null });
  });
});

describe('readOptions', () => {
  it('reads each kind from its own field', () => {
    const role = { id: 'r1' };
    const values = readOptions(
      { name: opt.string({ description: 'n' }), count: opt.number({ description: 'c' }), who: opt.role({ description: 'w' }) },
      source({ name: 'x', count: 1.5, who: role }),
    );
    expect(values).toEqual({ name: 'x', count: 1.5, who: role });
  });

  it('prefers the member for mentionables', () => {
    const member = { id: 'm1' };
    const values = readOptions(
      { target: opt.mentionable({ description: 't' }) },
      { get: () => ({ member, user: { id: 'u1' } }) },
    );
    expect(values.target).toBe(member);
  });

  it('fails when a required option is missing', () => {
    expect(() => readOptions({ name: opt.string({ description: 'n', required: true }) }, source({}))).toThrow(
      'Required option "name" is missing',
    );
  });
});

describe('names and descriptions', () => {
  it('accepts Discord-safe lowercase names only', () => {
    expect(() => assertName('Option', 'ignore-bots')).not.toThrow();
    expect(() => assertName('Option', 'Ignore')).toThrow('Option name "Ignore"');
    expect(() => assertName('Option', 'a'.repeat(33))).toThrow();
  });

  it('requires 1 to 100 characters of description', () => {
    expect(() => assertDescription('Option', 'x', '')).toThrow('Option "x" needs a description of 1 to 100 characters');
    expect(() => assertDescription('Option', 'x', 'a'.repeat(101))).toThrow();
  });
});
