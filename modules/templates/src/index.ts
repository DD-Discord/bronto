import { defineModule, on, type ModuleDefinition } from '@bronto/core';
import { Events, GatewayIntentBits } from 'discord.js';
import { templatesApi, type TemplatesApi } from './api.js';
import { previewButtons } from './buttons.js';
import { createTemplatesCommand } from './commands.js';
import * as schema from './db/schema.js';
import { templatesEvents, templatesGates } from './events.js';
import { onThreadCreate } from './new-post.js';

/** The templates module; the default export is the one deployments load. */
export function createTemplatesModule(): ModuleDefinition<Record<string, never>, TemplatesApi> {
  return defineModule<Record<string, never>, TemplatesApi>({
    name: 'templates',
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
    events: templatesEvents,
    gates: templatesGates,
    listeners: [on(Events.ThreadCreate, (ctx, thread, newlyCreated) => onThreadCreate(ctx, thread, newlyCreated))],
    commands: { templates: createTemplatesCommand() },
    components: previewButtons,
    api: (ctx) => templatesApi(ctx),
  });
}

export default createTemplatesModule();
export type { TemplatesApi } from './api.js';
export type { TemplateMessage } from './content.js';
export type { ImageSlot, Template, TemplateImage } from './db/schema.js';
export { templatesEvents, templatesGates } from './events.js';
