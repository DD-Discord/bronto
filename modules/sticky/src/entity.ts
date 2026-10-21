import { defineEntity, formatDuration, type HandlerContext } from '@bronto/core';
import templates, { escapeLinkText } from '@bronto/templates';
import { stickies, type Sticky } from './db/schema.js';

/** What the templates module tells about a template: its name and a link to its post. */
export interface TemplateInfo {
  name: string;
  url: string;
}

/** The Template field of a sticky: the template's name linked to its post, or a note when it is missing. */
export function templateField(sticky: Pick<Sticky, 'templateId'>, template: TemplateInfo | null): string {
  if (template === null) return `Missing (\`${sticky.templateId}\`)`;
  return `[${escapeLinkText(template.name)}](${template.url})`;
}

/** Name and post link of a sticky's template, or null when it no longer exists. */
export const templateOf = (ctx: HandlerContext, templateId: string): Promise<TemplateInfo | null> =>
  ctx.modules.get(templates).get(templateId);

export const stickyEntity = defineEntity({
  table: stickies,
  key: 'channelId',
  displayName: { singular: 'Sticky', plural: 'Stickies' },
  formatShort: (sticky) => `<#${sticky.channelId}>`,
  formatFull: async (sticky, base, ctx) =>
    base().addFields(
      { name: 'Template', value: templateField(sticky, await templateOf(ctx, sticky.templateId)) },
      { name: 'Ignore bots', value: sticky.ignoreBots ? 'Yes' : 'No', inline: true },
      { name: 'Silent', value: sticky.silent ? 'Yes' : 'No', inline: true },
      { name: 'Debounce', value: sticky.debounceMs === 0 ? 'Off' : formatDuration(sticky.debounceMs), inline: true },
    ),
});
