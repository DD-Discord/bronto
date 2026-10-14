import { text, timestamp } from 'drizzle-orm/pg-core';
import { currentActor } from './context.js';

/**
 * Audit columns carried by every bronto table. `*_by` holds the acting Discord user, or null for the bot itself.
 * Returns fresh column builders on each call, as builders cannot be shared between tables.
 */
export function auditColumns() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
    createdBy: text('created_by').$type<string | null>().$defaultFn(currentActor),
    updatedBy: text('updated_by').$type<string | null>().$defaultFn(currentActor).$onUpdateFn(currentActor),
  };
}
