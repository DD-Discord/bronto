import type { Autocomplete } from '@bronto/core';
import templates from './index.js';

/**
 * Templates whose name contains the query, as `name · created date` (UTC). For modules that list `templates` in
 * `dependsOn`; it goes through their `ctx.modules`.
 */
export const suggestTemplates: Autocomplete = async (ctx, query) =>
  (await ctx.modules.get(templates).search(query)).map((template) => ({
    name: `${template.name} · ${template.createdAt.toISOString().slice(0, 10)}`,
    value: template.id,
  }));
