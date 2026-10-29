import { channelKeyOption, TEXT_CHANNEL_TYPES, crudSubcommands, defineCommand, opt, UserError, type Autocomplete, type ChannelRuleIndex, type CommandDefinition } from '@bronto/core';
import templates, { TIMESTAMP_PLACEHOLDERS } from '@bronto/templates';
import { PermissionFlagsBits } from 'discord.js';
import type { Rule } from './db/schema.js';
import { ruleEntity } from './entity.js';

const MAX_SLOWMODE_MS = 6 * 60 * 60 * 1000;

/** Templates whose name contains the query, as `name · created date` (UTC). */
const suggestTemplates: Autocomplete = async (ctx, query) =>
  (await ctx.modules.get(templates).search(query)).map((template) => ({
    name: `${template.name} · ${template.createdAt.toISOString().slice(0, 10)}`,
    value: template.id,
  }));

export function createAutothreadCommand(deps: { index: ChannelRuleIndex<Rule> }): CommandDefinition {
  return defineCommand({
    description: 'Opens a thread for every post in a channel',
    permissions: PermissionFlagsBits.ManageChannels,
    subcommands: crudSubcommands(ruleEntity, {
      style: 'set',
      key: channelKeyOption({ description: 'Channel of the rule (default: this one)', channelTypes: TEXT_CHANNEL_TYPES }),
      fields: {
        'name-format': {
          option: opt.string({ description: 'Thread name, e.g. [Comments] {user.display} (default)', maxLength: 100 }),
          column: 'nameFormat',
          default: '[Comments] {user.display}',
        },
        slowmode: {
          option: opt.duration({ description: 'Slowmode of new threads, e.g. 10s (default: off)', max: MAX_SLOWMODE_MS }),
          column: 'slowmodeSeconds',
          toColumn: (ms: number) => Math.floor(ms / 1000),
          default: 0,
        },
        // Checked in `prepare`, which stores the template ID.
        'auto-message': {
          option: opt.string({ description: 'Template posted as the first message in each thread', autocomplete: suggestTemplates }),
          // A null default keeps the option optional when `set` creates a rule; the value only reaches `prepare`.
          default: null as never,
        },
        'remove-auto-message': { option: opt.boolean({ description: 'Stop posting a first message in new threads' }), default: null as never },
        rename: { option: opt.boolean({ description: 'Let the post author rename the thread (default: no)' }), column: 'rename', default: false },
        enabled: { option: opt.boolean({ description: 'Apply the rule (default: yes)' }), column: 'enabled', default: true },
        'ignore-bots': {
          option: opt.boolean({ description: 'Leave posts of bots and webhooks alone (default: yes)' }),
          column: 'ignoreBots',
          default: true,
        },
      },
      descriptions: {
        set: 'Creates or changes the rule of a channel (default: this one)',
        show: 'Shows the rule of a channel (default: this one)',
        list: 'Lists the autothread rules of this server',
        remove: 'Removes the rule of a channel (default: this one)',
      },
      hooks: {
        prepare: async (ctx, values) => {
          const template = values['auto-message'];
          if (template !== null && values['remove-auto-message'] === true) {
            throw new UserError('Use either `auto-message` or `remove-auto-message`, not both.');
          }
          if (template !== null) {
            if ((await ctx.modules.get(templates).get(template)) === null) throw new UserError("That template doesn't exist.");
            return { templateId: template };
          }
          return values['remove-auto-message'] === true ? { templateId: null } : {};
        },
        validate: (record) => {
          const used = TIMESTAMP_PLACEHOLDERS.filter((key) => record.nameFormat?.includes(`{${key}}`)).map((key) => `\`{${key}}\``);
          if (used.length === 0) return [];
          return [`Thread names show ${used.join(' and ')} as raw text. Use \`{date.iso}\` for the date instead.`];
        },
        afterWrite: (_ctx, record) => deps.index.set(record),
        beforeDelete: (_ctx, record) => deps.index.delete(record.guildId, record.channelId),
      },
    }),
  });
}
