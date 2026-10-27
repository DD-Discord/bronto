import { UserError } from '@bronto/core';
import { eq } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { forms, type Form } from './db/schema.js';
import { refreshOpeners } from './openers.js';
import { updatePreview } from './preview.js';
import type { Draft } from './retry.js';

/** Wrong input: the reply names the problem and offers [Try again] with what was typed. */
export class TryAgainError extends UserError {
  constructor(
    message: string,
    readonly draft: Draft,
  ) {
    super(message);
  }
}

type Change = Partial<Pick<Form, 'name' | 'active' | 'channelId' | 'pingUserIds' | 'pingRoleIds' | 'allowedRoleIds' | 'oncePerMember' | 'fields' | 'removedFieldIds'>>;

/** Renames the post with the form and edits its preview; false when either failed. */
async function showChange(ctx: FormsContext, before: Form, form: Form): Promise<boolean> {
  let ok = true;
  if (form.name !== before.name) {
    try {
      const thread = await ctx.client.channels.fetch(form.threadId);
      if (thread?.isThread() === true && thread.name !== form.name) await thread.setName(form.name);
    } catch (error) {
      ctx.log.warn({ err: error, formId: form.id, threadId: form.threadId }, 'Renaming the post of a renamed form failed');
      ok = false;
    }
  }
  try {
    await updatePreview(ctx, form);
  } catch (error) {
    ctx.log.warn({ err: error, formId: form.id, threadId: form.threadId }, 'Updating the preview of a changed form failed');
    ok = false;
  }
  return ok;
}

/**
 * Applies `change` to the form under a row lock, then shows the result: the post is renamed with the form, the preview
 * edited in place, and the openers refreshed when their name or activity changed. `postUpdated` is false when the
 * post couldn't be brought up to date; the change itself is saved.
 */
export async function changeForm(
  ctx: FormsContext,
  formId: string,
  change: (form: Form) => Change,
): Promise<{ before: Form; form: Form; postUpdated: boolean }> {
  const { before, form } = await ctx.db.run(async (tx) => {
    const [current] = await tx.select().from(forms).where(eq(forms.id, formId)).for('update');
    if (current === undefined) throw new UserError('This form no longer exists.');
    const [updated] = await tx.update(forms).set(change(current)).where(eq(forms.id, formId)).returning();
    return { before: current, form: updated! };
  });
  const postUpdated = await showChange(ctx, before, form);
  if (form.active !== before.active || form.name !== before.name) {
    try {
      await refreshOpeners(ctx, formId);
    } catch (error) {
      ctx.log.warn({ err: error, formId }, 'Refreshing the openers of a changed form failed');
    }
  }
  return { before, form, postUpdated };
}

/** The reply to a saved change. */
export const savedMessage = (text: string, postUpdated: boolean) => (postUpdated ? text : `${text} The post couldn't be updated; try again later.`);
