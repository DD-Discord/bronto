import { PermissionFlagsBits } from 'discord.js';
import type { ModuleRuntime } from '../runtime/context.js';
import type { ModuleEnablement } from '../runtime/enablement.js';
import { defineCommand, defineSubcommand, type CommandDefinition } from './commands.js';
import type { CommandContext } from './context.js';
import { UserError } from './errors.js';
import { batchLines } from './format.js';
import { opt } from './options.js';

export interface ModulesCommandOptions {
  runtimes: ModuleRuntime[];
  enablement: ModuleEnablement;
  setModuleEnabled: (guildId: string, module: string, enabled: boolean, actorId: string | null) => Promise<boolean>;
}

const bold = (names: string[]) => names.map((name) => `**${name}**`).join(', ');

/** Core's `/modules` command: lists the loaded modules and switches them per server. */
export function createModulesCommand(options: ModulesCommandOptions): CommandDefinition {
  const { runtimes, enablement } = options;
  const find = (name: string): ModuleRuntime => {
    const runtime = runtimes.find((candidate) => candidate.name === name);
    if (runtime === undefined) throw new UserError(`There is no module called "${name}".`);
    return runtime;
  };
  const dependenciesOf = (runtime: ModuleRuntime) => (runtime.loaded.definition.dependsOn ?? []).map((dependency) => dependency.name);
  const moduleOption = opt.string({
    description: 'The module',
    required: true,
    autocomplete: (_ctx, query) =>
      runtimes
        .filter((runtime) => runtime.name.includes(query.toLowerCase()))
        .map((runtime) => ({ name: runtime.name, value: runtime.name })),
  });

  async function enable(ctx: CommandContext, name: string): Promise<void> {
    const runtime = find(name);
    const off = dependenciesOf(runtime).filter((dependency) => !enablement.isEnabled(ctx.guildId, dependency));
    if (off.length > 0) {
      throw new UserError(`Turn on ${bold(off)} first; **${name}** depends on ${off.length === 1 ? 'it' : 'them'}.`);
    }
    const changed = await options.setModuleEnabled(ctx.guildId, name, true, ctx.actorId);
    await ctx.reply(changed ? `Turned on **${name}**.` : `**${name}** is already on.`);
  }

  async function disable(ctx: CommandContext, name: string): Promise<void> {
    find(name);
    const dependents = runtimes
      .filter((runtime) => dependenciesOf(runtime).includes(name) && enablement.isEnabled(ctx.guildId, runtime.name))
      .map((runtime) => runtime.name);
    if (dependents.length > 0) {
      throw new UserError(`Turn off ${bold(dependents)} first; ${dependents.length === 1 ? 'it depends' : 'they depend'} on **${name}**.`);
    }
    const changed = await options.setModuleEnabled(ctx.guildId, name, false, ctx.actorId);
    await ctx.reply(changed ? `Turned off **${name}**.` : `**${name}** is already off.`);
  }

  return defineCommand({
    name: 'modules',
    description: 'Shows and switches the modules of this server',
    permissions: PermissionFlagsBits.Administrator,
    subcommands: {
      list: defineSubcommand({
        description: 'Lists the modules and whether they are on in this server',
        ephemeral: true,
        execute: async (ctx) => {
          if (runtimes.length === 0) {
            await ctx.reply('No modules are loaded.');
            return;
          }
          const lines = runtimes.map(
            (runtime) =>
              `- **${runtime.name}** (\`${runtime.loaded.packageName}\`): ${enablement.isEnabled(ctx.guildId, runtime.name) ? 'on' : 'off'}`,
          );
          for (const chunk of batchLines(lines)) await ctx.reply(chunk);
        },
      }),
      enable: defineSubcommand({
        description: 'Turns a module on in this server',
        ephemeral: true,
        options: { module: moduleOption },
        execute: (ctx, { module }) => enable(ctx, module),
      }),
      disable: defineSubcommand({
        description: 'Turns a module off in this server; its data is kept',
        ephemeral: true,
        options: { module: moduleOption },
        execute: (ctx, { module }) => disable(ctx, module),
      }),
    },
  });
}
