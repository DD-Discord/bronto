import { Routes, type Client, type RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { Logger } from 'pino';
import { KeyedQueue } from '../runtime/queue.js';

export type CommandJson = RESTPostAPIChatInputApplicationCommandsJSONBody;

/** Where a guild's commands are registered. */
export interface CommandRegistry {
  fetch(guildId: string): Promise<unknown[]>;
  /** Replaces the guild's whole command list (bulk overwrite). */
  overwrite(guildId: string, commands: CommandJson[]): Promise<void>;
}

export function restCommandRegistry(client: Client): CommandRegistry {
  const route = (guildId: string) => {
    const applicationId = client.application?.id;
    if (applicationId === undefined) throw new Error('The client is not ready; its application ID is unknown.');
    return Routes.applicationGuildCommands(applicationId, guildId);
  };
  return {
    async fetch(guildId) {
      return (await client.rest.get(route(guildId))) as unknown[];
    },
    async overwrite(guildId, commands) {
      await client.rest.put(route(guildId), { body: commands });
    },
  };
}

interface RawOption {
  type?: number;
  name?: string;
  description?: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  channel_types?: number[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  options?: RawOption[];
}

interface RawCommand {
  type?: number;
  name?: string;
  description?: string;
  default_member_permissions?: string | null;
  nsfw?: boolean;
  options?: RawOption[];
}

// Keeps only the fields bronto sets, with Discord's defaults filled in, so a registered command compares equal to the
// definition it was created from.
function normalizeOption(option: RawOption): unknown {
  return {
    type: option.type,
    name: option.name,
    description: option.description,
    required: option.required ?? false,
    autocomplete: option.autocomplete ?? false,
    choices: (option.choices ?? []).map(({ name, value }) => ({ name, value })),
    channel_types: [...(option.channel_types ?? [])].sort((a, b) => a - b),
    min_value: option.min_value ?? null,
    max_value: option.max_value ?? null,
    min_length: option.min_length ?? null,
    max_length: option.max_length ?? null,
    options: (option.options ?? []).map(normalizeOption),
  };
}

function normalizeCommands(commands: unknown[]): unknown[] {
  return (commands as RawCommand[])
    .map((command) => ({
      type: command.type ?? 1,
      name: command.name ?? '',
      description: command.description,
      default_member_permissions: command.default_member_permissions ?? null,
      nsfw: command.nsfw ?? false,
      options: (command.options ?? []).map(normalizeOption),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function commandsEqual(registered: unknown[], desired: unknown[]): boolean {
  return JSON.stringify(normalizeCommands(registered)) === JSON.stringify(normalizeCommands(desired));
}

export interface CommandSyncOptions {
  registry: CommandRegistry;
  /** The full command list a guild should have, read when its sync starts. */
  desired: (guildId: string) => CommandJson[];
  log: Logger;
}

/** Keeps each guild's registered commands in line with its enabled modules, writing only on a difference. */
export class CommandSync {
  private readonly options: CommandSyncOptions;
  private readonly queue: KeyedQueue;

  constructor(options: CommandSyncOptions) {
    this.options = options;
    this.queue = new KeyedQueue((guildId, error) => {
      options.log.error({ err: error, guildId }, 'Updating the commands of a guild failed');
    });
  }

  sync(guildId: string): Promise<void> {
    return this.queue.run(guildId, async () => {
      const desired = this.options.desired(guildId);
      const registered = await this.options.registry.fetch(guildId);
      if (commandsEqual(registered, desired)) return;
      await this.options.registry.overwrite(guildId, desired);
      this.options.log.info({ guildId, commands: desired.map((command) => command.name) }, 'Updated the commands of a guild');
    });
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }
}
