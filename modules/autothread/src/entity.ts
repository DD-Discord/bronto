import { defineEntity, formatDuration } from '@bronto/core';
import templates, { escapeLinkText } from '@bronto/templates';
import { rules } from './db/schema.js';

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

export const ruleEntity = defineEntity({
  table: rules,
  key: 'channelId',
  displayName: { singular: 'Autothread rule', plural: 'Autothread rules' },
  formatShort: (rule) => `<#${rule.channelId}> \`${rule.nameFormat}\``,
  formatFull: async (rule, base, ctx) => {
    const template = rule.templateId === null ? null : await ctx.modules.get(templates).get(rule.templateId);
    return base().addFields(
      { name: 'Thread name', value: `\`${rule.nameFormat}\`` },
      { name: 'Slowmode', value: rule.slowmodeSeconds === 0 ? 'Off' : formatDuration(rule.slowmodeSeconds * 1000), inline: true },
      {
        name: 'Auto-message',
        value: rule.templateId === null ? 'None' : template === null ? 'Missing template' : `[${escapeLinkText(template.name)}](${template.url})`,
        inline: true,
      },
      { name: 'Rename button', value: yesNo(rule.rename), inline: true },
      { name: 'Enabled', value: yesNo(rule.enabled), inline: true },
      { name: 'Ignore bots', value: yesNo(rule.ignoreBots), inline: true },
    );
  },
});
