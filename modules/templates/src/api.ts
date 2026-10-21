import type { TemplateMessage } from './content.js';

export interface TemplatesApi {
  /** What to post; null if the template doesn't exist. */
  render(id: string): Promise<TemplateMessage | null>;
  /** Name and post link; null if missing. */
  get(id: string): Promise<{ id: string; name: string; url: string } | null>;
  /** For autocomplete: templates whose name matches, max 25. */
  search(query: string): Promise<{ id: string; name: string; createdAt: Date }[]>;
  /** Creates a template and its post; returns the existing one if `id` is taken. */
  create(input: { id?: string; name: string } & TemplateMessage): Promise<{ id: string }>;
}
