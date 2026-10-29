import { defineButton, type ButtonContext, type ButtonDefinition } from '@bronto/core';
import { CONFIRM_MS } from './limits.js';
import type { PendingMove, PendingMoves } from './pending.js';

/** Carries out a confirmed move; the button has already answered "Moving…". */
export type RunMove = (ctx: ButtonContext, move: PendingMove) => Promise<void>;

export interface MoveButtons {
  confirm: ButtonDefinition;
  cancel: ButtonDefinition;
}

const button = (name: string, execute: ButtonDefinition['execute']): ButtonDefinition =>
  defineButton({ name, bind: { user: true }, expiresAfterMs: CONFIRM_MS, defer: 'update', ephemeral: true, execute });

export function createMoveButtons(deps: { pending: PendingMoves; run: RunMove }): MoveButtons {
  return {
    confirm: button('move-confirm', async (ctx, [token]) => {
      const move = deps.pending.take(token!);
      if (move === null) {
        await ctx.update({ content: 'This move has expired. Run `/move` again.', components: [] });
        return;
      }
      await ctx.update({ content: 'Moving…', components: [] });
      await deps.run(ctx, move);
    }),
    cancel: button('move-cancel', async (ctx, [token]) => {
      deps.pending.take(token!);
      await ctx.update({ content: 'Move cancelled.', components: [] });
    }),
  };
}
