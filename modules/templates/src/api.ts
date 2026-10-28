import { asc, eq, ilike, sql } from 'drizzle-orm';
import type { TemplateMessage } from './content.js';
import type { TemplatesContext } from './context.js';
import { templates } from './db/schema.js';
import { createPost } from './posts.js';
import { render } from './render.js';

export interface TemplatesApi {
  /**
   * What to post; null if the template doesn't exist. `values` fill `{key}` placeholders in its text (see
   * `postPlaceholders`); unknown keys stay, and each field is cut to Discord's limit.
   */
  render(id: string, values?: Readonly<Record<string, string>>): Promise<TemplateMessage | null>;
  /** Name and post link; null if missing. */
  get(id: string): Promise<{ id: string; name: string; url: string } | null>;
  /** For autocomplete: templates whose name contains the query (any case), by name, max 25. */
  search(query: string): Promise<{ id: string; name: string; createdAt: Date }[]>;
  /** Creates a template and its post; returns the existing one if `id` is taken. */
  create(input: { id?: string; name: string } & TemplateMessage): Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULTS = 25;

/** The API other modules get; each call runs in the calling handler's guild. */
export function templatesApi(ctx: TemplatesContext): TemplatesApi {
  const find = async (id: string) => {
    if (!UUID.test(id)) return null;
    const [row] = await ctx.db.run(async (tx) =>
      tx.select({ id: templates.id, name: templates.name, threadId: templates.threadId }).from(templates).where(eq(templates.id, id)),
    );
    return row ?? null;
  };

  return {
    render: async (id, values) => (UUID.test(id) ? render(ctx, id, values) : null),
    get: async (id) => {
      const row = await find(id);
      return row === null ? null : { id: row.id, name: row.name, url: `https://discord.com/channels/${ctx.guildId}/${row.threadId}` };
    },
    search: async (query) => {
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      return ctx.db.run(async (tx) =>
        tx
          .select({ id: templates.id, name: templates.name, createdAt: templates.createdAt })
          .from(templates)
          .where(ilike(templates.name, pattern))
          .orderBy(sql`lower(${templates.name})`, asc(templates.name), asc(templates.createdAt))
          .limit(MAX_RESULTS),
      );
    },
    create: async (input) => {
      if (input.id !== undefined) {
        if (!UUID.test(input.id)) throw new Error(`Template IDs are UUIDs; got "${input.id}".`);
        if ((await find(input.id)) !== null) return { id: input.id };
      }
      const template = await createPost(ctx, { id: input.id, name: input.name, content: input.content, embed: input.embed });
      return { id: template.id };
    },
  };
}
