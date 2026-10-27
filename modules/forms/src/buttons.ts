import { defineButton, type ButtonDefinition } from '@bronto/core';

/** A preview button: signed for the form's thread, without arguments or expiry. */
function previewButton(name: string): ButtonDefinition {
  return defineButton({
    name,
    bind: { channel: true },
    ephemeral: true,
    execute: async (ctx) => {
      await ctx.reply('Not available yet.');
    },
  });
}

export const addFieldButton = previewButton('add-field');
export const editFieldButton = previewButton('edit-field');
export const settingsButton = previewButton('settings');
export const exportButton = previewButton('export');
export const importButton = previewButton('import');
export const deleteButton = previewButton('delete');

export const previewComponents = [addFieldButton, editFieldButton, settingsButton, exportButton, importButton, deleteButton];
