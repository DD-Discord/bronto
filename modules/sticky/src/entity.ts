import { defineEntity, formatDuration } from '@bronto/core';
import { escapeLinkText } from '@bronto/templates';
import { stickies, type Sticky } from './db/schema.js';

/** What the templates module tells about a template: its name and a link to its post. */
export interface TemplateInfo {
  name: string;
  url: string;
}

/**
 * The Template field of a sticky: the template's name linked to its post, a note when it is missing, or (when it wasn't
 * looked up) its ID.
 */
export function templateField(sticky: Pick<Sticky, 'templateId'>, template?: TemplateInfo | null): string {
  if (template === undefined) return `\`${sticky.templateId}\``;
  if (template === null) return `Missing (\`${sticky.templateId}\`)`;
  return `[${escapeLinkText(template.name)}](${template.url})`;
}

export const stickyEntity = defineEntity({
  table: stickies,
  key: 'channelId',
  displayName: { singular: 'Sticky', plural: 'Stickies' },
  formatShort: (sticky) => `<#${sticky.channelId}>`,
  formatFull: (sticky, base) =>
    base().addFields(
      { name: 'Template', value: templateField(sticky) },
      { name: 'Ignore bots', value: sticky.ignoreBots ? 'Yes' : 'No', inline: true },
      { name: 'Silent', value: sticky.silent ? 'Yes' : 'No', inline: true },
      { name: 'Debounce', value: sticky.debounceMs === 0 ? 'Off' : formatDuration(sticky.debounceMs), inline: true },
    ),
});
