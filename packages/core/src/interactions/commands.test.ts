import { ApplicationCommandOptionType, ApplicationCommandType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { checkCommand, commandToJson, defineCommand, defineSubcommand, findHandler, subcommandPath } from './commands.js';
import { opt } from './options.js';

const noop = () => undefined;

describe('defineCommand', () => {
  it('builds a leaf command with required options first', () => {
    const command = defineCommand({
      description: 'Checks the bot',
      permissions: PermissionFlagsBits.ManageMessages,
      options: { note: opt.string({ description: 'Note' }), times: opt.integer({ description: 'Times', required: true }) },
      execute: noop,
    });
    expect(commandToJson('ping', command)).toEqual({
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
      description: 'Things',
      subcommands: { create },
      groups: { rules: { description: 'Rules', subcommands: { add } } },
    });
    expect(commandToJson('thing', command)).toMatchObject({
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
    const check = (name: string, command: unknown) => () => checkCommand(name, command as never);
    expect(check('Bad', defineCommand({ description: 'x', execute: noop }))).toThrow('Command name "Bad"');
    expect(check('empty', defineCommand({ description: 'x' } as never))).toThrow(
      'Command "empty" needs either execute or subcommands',
    );
    expect(
      check('both', defineCommand({ description: 'x', execute: noop, subcommands: { a: defineSubcommand({ description: 'a', execute: noop }) } } as never)),
    ).toThrow('Command "both" needs either execute or subcommands');
    const many = Object.fromEntries(
      Array.from({ length: 26 }, (_, i) => [`o${i}`, opt.string({ description: 'x' })]),
    );
    expect(check('many', defineCommand({ description: 'x', options: many, execute: noop }))).toThrow('at most 25');
    expect(
      check(
        'clash',
        defineCommand({
          description: 'x',
          subcommands: { a: defineSubcommand({ description: 'a', execute: noop }) },
          groups: { a: { description: 'g', subcommands: { b: defineSubcommand({ description: 'b', execute: noop }) } } },
        }),
      ),
    ).toThrow('"a" is both a subcommand and a group');
  });

  it('names the command in validation errors', () => {
    const command = defineCommand({ description: 'Demo', subcommands: {} });
    expect(() => checkCommand('demo', command)).toThrow('Command "demo" needs either execute or subcommands, not both or neither.');
  });

  it('rejects invalid command names', () => {
    const command = defineCommand({ description: 'Demo', execute: noop });
    expect(() => checkCommand('Bad Name', command)).toThrow();
  });

  it('rejects bad option names and descriptions', () => {
    const camel = { ignoreBots: opt.boolean({ description: 'Ignore bots' }) };
    expect(() =>
      checkCommand(
        'cfg',
        defineCommand({ description: 'x', subcommands: { set: defineSubcommand({ description: 'Sets', options: camel, execute: noop }) } }),
      ),
    ).toThrow('Option name "ignoreBots"');
    expect(() => checkCommand('leaf', defineCommand({ description: 'x', options: camel, execute: noop }))).toThrow(
      'Option name "ignoreBots"',
    );
    expect(() =>
      checkCommand('long', defineCommand({ description: 'x', options: { note: opt.string({ description: 'n'.repeat(101) }) }, execute: noop })),
    ).toThrow('Option "note" needs a description of 1 to 100 characters.');
  });
});
