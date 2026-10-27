import { defineButton } from '@bronto/core';
import { openForm } from './fill.js';

/** The button on openers: any member may press it, and the ID never expires. */
export const openButton = defineButton({
  name: 'open',
  ephemeral: true,
  execute: async (ctx, args) => {
    await openForm(ctx, args[0] ?? '');
  },
});
