import { defineEntity, yesNo } from '@bronto/core';
import { rules } from './db/schema.js';


export const ruleEntity = defineEntity({
  table: rules,
  key: 'channelId',
  displayName: { singular: 'Media-only rule', plural: 'Media-only rules' },
  formatShort: (rule) => `<#${rule.channelId}>`,
  formatFull: (rule, base) =>
    base().addFields(
      { name: 'Enabled', value: yesNo(rule.enabled), inline: true },
      { name: 'Ignore bots', value: yesNo(rule.ignoreBots), inline: true },
      { name: 'Require spoiler', value: yesNo(rule.requireSpoiler), inline: true },
      { name: 'Log channel', value: rule.logChannelId === null ? 'None' : `<#${rule.logChannelId}>` },
    ),
});
