import { defineEntity, formatDuration, yesNo } from '@bronto/core';
import { rules } from './db/schema.js';

const duration = (ms: number) => (ms === 0 ? 'Off' : formatDuration(ms));

export const ruleEntity = defineEntity({
  table: rules,
  key: 'channelId',
  displayName: { singular: 'Auto-delete rule', plural: 'Auto-delete rules' },
  formatShort: (rule) => `<#${rule.channelId}>`,
  formatFull: (rule, base) =>
    base().addFields(
      { name: 'Enabled', value: yesNo(rule.enabled), inline: true },
      { name: 'Keep latest', value: yesNo(rule.keepLatest), inline: true },
      { name: 'Delete on leave', value: yesNo(rule.deleteOnLeave), inline: true },
      { name: 'Cooldown', value: duration(rule.cooldownMs), inline: true },
      { name: 'Grace', value: duration(rule.graceMs), inline: true },
      { name: 'DM members', value: yesNo(rule.notifyDm), inline: true },
      { name: 'Log channel', value: rule.logChannelId === null ? 'None' : `<#${rule.logChannelId}>` },
    ),
});
