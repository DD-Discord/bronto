import { defineButton, UserError, type ButtonDefinition } from '@bronto/core';

/** A preview button: signed for the template's thread, without arguments or expiry. */
function previewButton(name: string): ButtonDefinition {
  return defineButton({
    name,
    bind: { channel: true },
    ephemeral: true,
    execute: () => {
      throw new UserError('Not available yet.');
    },
  });
}

export const editButton = previewButton('edit');
export const exportButton = previewButton('export');
export const importButton = previewButton('import');
export const deleteButton = previewButton('delete');

export const previewButtons = [editButton, exportButton, importButton, deleteButton];
