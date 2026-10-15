import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  type APIApplicationCommandBasicOption,
  type APIApplicationCommandSubcommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { CommandContext } from './context.js';
import { assertDescription, assertName, optionToJson, type OptionMap, type OptionValues } from './options.js';

const MAX_PER_LEVEL = 25;

export interface SubcommandDefinition<O extends OptionMap = OptionMap> {
  readonly description: string;
  readonly options?: O;
  /** Replies and automatic defers are visible only to the user unless a reply says otherwise. */
  readonly ephemeral?: boolean;
  execute(ctx: CommandContext, options: OptionValues<O>): unknown;
}

export function defineSubcommand<O extends OptionMap = {}>(definition: SubcommandDefinition<O>): SubcommandDefinition<O> {
  return definition;
}

export interface SubcommandGroup {
  readonly description: string;
  readonly subcommands: Record<string, SubcommandDefinition<any>>;
}

interface CommandBase {
  name: string;
  description: string;
  /** Members need these permissions to see the command (`default_member_permissions`); server admins can change it. */
  permissions?: bigint | null;
  /** Discord's age-restricted command flag. */
  nsfw?: boolean;
}

export type CommandInput<O extends OptionMap> =
  | (CommandBase & SubcommandDefinition<O> & { subcommands?: never; groups?: never })
  | (CommandBase & {
      subcommands?: Record<string, SubcommandDefinition<any>>;
      groups?: Record<string, SubcommandGroup>;
      execute?: never;
      options?: never;
    });

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly permissions: bigint | null;
  readonly nsfw: boolean;
  /** The command's own handler; null when it has subcommands. */
  readonly handler: SubcommandDefinition<any> | null;
  readonly subcommands: Record<string, SubcommandDefinition<any>>;
  readonly groups: Record<string, SubcommandGroup>;
}

function checkOptions(owner: string, options: OptionMap | undefined): void {
  const names = Object.keys(options ?? {});
  if (names.length > MAX_PER_LEVEL) throw new Error(`${owner} can have at most ${MAX_PER_LEVEL} options.`);
}

function checkSubcommands(owner: string, subcommands: Record<string, SubcommandDefinition<any>>): void {
  for (const [name, subcommand] of Object.entries(subcommands)) {
    assertName('Subcommand', name);
    assertDescription('Subcommand', name, subcommand.description);
    checkOptions(`Subcommand "${owner} ${name}"`, subcommand.options);
  }
}

export function defineCommand<O extends OptionMap = {}>(input: CommandInput<O>): CommandDefinition {
  assertName('Command', input.name);
  assertDescription('Command', input.name, input.description);
  const subcommands = input.subcommands ?? {};
  const groups = input.groups ?? {};
  const nested = Object.keys(subcommands).length + Object.keys(groups).length;
  const hasExecute = typeof input.execute === 'function';
  if (hasExecute === nested > 0) {
    throw new Error(`Command "${input.name}" needs either execute or subcommands, not both or neither.`);
  }
  if (nested > MAX_PER_LEVEL) throw new Error(`Command "${input.name}" can have at most ${MAX_PER_LEVEL} subcommands and groups.`);
  checkSubcommands(input.name, subcommands);
  for (const [name, group] of Object.entries(groups)) {
    if (Object.hasOwn(subcommands, name)) throw new Error(`Command "${input.name}": "${name}" is both a subcommand and a group.`);
    assertName('Subcommand group', name);
    assertDescription('Subcommand group', name, group.description);
    const count = Object.keys(group.subcommands).length;
    if (count === 0 || count > MAX_PER_LEVEL) {
      throw new Error(`Subcommand group "${input.name} ${name}" needs 1 to ${MAX_PER_LEVEL} subcommands.`);
    }
    checkSubcommands(`${input.name} ${name}`, group.subcommands);
  }
  let handler: SubcommandDefinition<any> | null = null;
  if (hasExecute) {
    const leaf = input as SubcommandDefinition<O>;
    checkOptions(`Command "${input.name}"`, leaf.options);
    handler = { description: input.description, options: leaf.options, ephemeral: leaf.ephemeral, execute: leaf.execute };
  }
  return {
    name: input.name,
    description: input.description,
    permissions: input.permissions ?? null,
    nsfw: input.nsfw ?? false,
    handler,
    subcommands,
    groups,
  };
}

/** The handler for an invoked command path, or null when the command no longer has it. */
export function findHandler(
  command: CommandDefinition,
  group: string | null,
  subcommand: string | null,
): SubcommandDefinition<any> | null {
  if (group !== null) {
    if (subcommand === null || !Object.hasOwn(command.groups, group)) return null;
    const subcommands = command.groups[group]!.subcommands;
    return Object.hasOwn(subcommands, subcommand) ? subcommands[subcommand]! : null;
  }
  if (subcommand !== null) return Object.hasOwn(command.subcommands, subcommand) ? command.subcommands[subcommand]! : null;
  return command.handler;
}

export function subcommandPath(group: string | null, subcommand: string | null): string {
  return [group, subcommand].filter((part) => part !== null).join(' ');
}

function optionsToJson(options: OptionMap | undefined): APIApplicationCommandBasicOption[] {
  const json = Object.entries(options ?? {}).map(([name, option]) => optionToJson(name, option));
  // Discord requires required options before optional ones; the sort is stable, so declared order is kept otherwise.
  return json.sort((a, b) => Number(b.required ?? false) - Number(a.required ?? false));
}

function subcommandsToJson(subcommands: Record<string, SubcommandDefinition<any>>): APIApplicationCommandSubcommandOption[] {
  return Object.entries(subcommands).map(([name, subcommand]) => ({
    type: ApplicationCommandOptionType.Subcommand,
    name,
    description: subcommand.description,
    options: optionsToJson(subcommand.options),
  }));
}

export function commandToJson(command: CommandDefinition): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const options =
    command.handler !== null
      ? optionsToJson(command.handler.options)
      : [
          ...subcommandsToJson(command.subcommands),
          ...Object.entries(command.groups).map(([name, group]) => ({
            type: ApplicationCommandOptionType.SubcommandGroup as const,
            name,
            description: group.description,
            options: subcommandsToJson(group.subcommands),
          })),
        ];
  return {
    type: ApplicationCommandType.ChatInput,
    name: command.name,
    description: command.description,
    default_member_permissions: command.permissions === null ? null : String(command.permissions),
    nsfw: command.nsfw,
    options,
  };
}
