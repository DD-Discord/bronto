import type { ButtonContext } from '@bronto/core';

/** Starts filling in the form behind an opener button. */
export async function openForm(ctx: ButtonContext, _openerId: string): Promise<void> {
  await ctx.reply({ content: "This form can't be filled in yet.", ephemeral: true });
}
