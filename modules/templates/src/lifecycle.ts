import { defineManagedForum } from '@bronto/core';
import { forums, templates } from './db/schema.js';
import { templatesEvents } from './events.js';
import { createFromPost } from './new-post.js';

/**
 * The template forum. A deleted post or forum deletes its templates (images go with them) and emits `deleted`; a
 * renamed post renames its template, which is not a content change, so no event fires.
 */
export const templateForum = defineManagedForum({
  forumName: 'templates',
  tables: { forums, records: templates },
  wording: { noun: 'template', forumLabel: 'template forum', logKey: 'templateId' },
  createFromPost: (ctx, thread) => createFromPost(ctx, thread),
  forgotOne: (ctx, record) => ctx.emit(templatesEvents.deleted, { id: record.id }),
  forgotAll: (ctx, records) => {
    for (const { id } of records) ctx.emit(templatesEvents.deleted, { id });
  },
});
