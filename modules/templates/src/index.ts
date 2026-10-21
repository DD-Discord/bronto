import { defineModule, type ModuleDefinition } from '@bronto/core';
import type { TemplatesApi } from './api.js';
import * as schema from './db/schema.js';

/** The templates module; the default export is the one deployments load. */
export function createTemplatesModule(): ModuleDefinition<Record<string, never>, TemplatesApi> {
  return defineModule<Record<string, never>, TemplatesApi>({
    name: 'templates',
    db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
  });
}

export default createTemplatesModule();
export type { TemplatesApi } from './api.js';
export type { TemplateMessage } from './content.js';
export type { ImageSlot, Template, TemplateImage } from './db/schema.js';
