import { defineEntity } from '@bronto/core';
import { rules } from './db/schema.js';

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

export const ruleEntity = defineEntity({
  table: rules,
  key: 'channelId',
  displayName: { singular: 'Autoreact rule', plural: 'Autoreact rules' },
  formatShort: (rule) => `<#${rule.channelId}> ${rule.emojis.join(' ')}`,
  formatFull: (rule, base) =>
    base().addFields(
      { name: 'Emojis', value: rule.emojis.join(' ') },
      { name: 'Enabled', value: yesNo(rule.enabled), inline: true },
      { name: 'Ignore bots', value: yesNo(rule.ignoreBots), inline: true },
      { name: 'Ignored members', value: rule.ignoredUserIds.length === 0 ? 'None' : rule.ignoredUserIds.map((id) => `<@${id}>`).join(' ') },
    ),
});
