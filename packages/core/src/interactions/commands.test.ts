import { ApplicationCommandOptionType, ApplicationCommandType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { commandToJson, defineCommand, defineSubcommand, findHandler, subcommandPath } from './commands.js';
import { opt } from './options.js';

const noop = () => undefined;

describe('defineCommand', () => {
  it('builds a leaf command with required options first', () => {
    const command = defineCommand({
      name: 'ping',
      description: 'Checks the bot',
      permissions: PermissionFlagsBits.ManageMessages,
      options: { note: opt.string({ description: 'Note' }), times: opt.integer({ description: 'Times', required: true }) },
      execute: noop,
    });
    expect(commandToJson(command)).toEqual({
      type: ApplicationCommandType.ChatInput,
      name: 'ping',
      description: 'Checks the bot',
      default_member_permissions: String(PermissionFlagsBits.ManageMessages),
      nsfw: false,
      options: [
        { type: ApplicationCommandOptionType.Integer, name: 'times', description: 'Times', required: true },
        { type: ApplicationCommandOptionType.String, name: 'note', description: 'Note', required: false },
      ],
    });
    expect(findHandler(command, null, null)).toBe(command.handler);
  });

  it('builds subcommands and groups and routes to them', () => {
    const create = defineSubcommand({ description: 'Creates', execute: noop });
    const add = defineSubcommand({ description: 'Adds', execute: noop });
    const command = defineCommand({
      name: 'thing',
      description: 'Things',
      subcommands: { create },
      groups: { rules: { description: 'Rules', subcommands: { add } } },
    });
    expect(commandToJson(command)).toMatchObject({
      default_member_permissions: null,
      options: [
        { type: ApplicationCommandOptionType.Subcommand, name: 'create', description: 'Creates', options: [] },
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: 'rules',
          description: 'Rules',
          options: [{ type: ApplicationCommandOptionType.Subcommand, name: 'add', description: 'Adds', options: [] }],
        },
      ],
    });
    expect(findHandler(command, null, 'create')).toBe(create);
    expect(findHandler(command, 'rules', 'add')).toBe(add);
    expect(findHandler(command, null, 'gone')).toBeNull();
    expect(findHandler(command, 'rules', 'create')).toBeNull();
    expect(findHandler(command, null, null)).toBeNull();
    expect(subcommandPath('rules', 'add')).toBe('rules add');
    expect(subcommandPath(null, null)).toBe('');
  });

  it('rejects invalid definitions', () => {
    expect(() => defineCommand({ name: 'Bad', description: 'x', execute: noop })).toThrow('Command name "Bad"');
    expect(() => defineCommand({ name: 'empty', description: 'x' } as never)).toThrow(
      'Command "empty" needs either execute or subcommands',
    );
    expect(() =>
      defineCommand({ name: 'both', description: 'x', execute: noop, subcommands: { a: defineSubcommand({ description: 'a', execute: noop }) } } as never),
    ).toThrow('Command "both" needs either execute or subcommands');
    const many = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`o${i}`, opt.string({ description: 'x' })]),
    );
    expect(() => defineCommand({ name: 'many', description: 'x', options: many, execute: noop })).toThrow(
      'at most 25',
    );
    expect(() =>
      defineCommand({
        name: 'clash',
        description: 'x',
        subcommands: { a: defineSubcommand({ description: 'a', execute: noop }) },
        groups: { a: { description: 'g', subcommands: { b: defineSubcommand({ description: 'b', execute: noop }) } } },
      }),
    ).toThrow('"a" is both a subcommand and a group');
  });

  it('rejects bad option names and descriptions when the command is defined', () => {
    const camel = { ignoreBots: opt.boolean({ description: 'Ignore bots' }) };
    expect(() =>
      defineCommand({
        name: 'cfg',
        description: 'x',
        subcommands: { set: defineSubcommand({ description: 'Sets', options: camel, execute: noop }) },
      }),
    ).toThrow('Option name "ignoreBots"');
    expect(() => defineCommand({ name: 'leaf', description: 'x', options: camel, execute: noop })).toThrow(
      'Option name "ignoreBots"',
    );
    expect(() =>
      defineCommand({ name: 'long', description: 'x', options: { note: opt.string({ description: 'n'.repeat(101) }) }, execute: noop }),
    ).toThrow('Option "note" needs a description of 1 to 100 characters.');
  });
});
