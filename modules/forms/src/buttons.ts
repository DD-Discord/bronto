import { defineButton, type ButtonContext, type ButtonDefinition } from '@bronto/core';

type Action = (ctx: ButtonContext) => Promise<void>;

const PREVIEW_BUTTONS = ['add-field', 'edit-field', 'settings', 'export', 'import', 'delete'] as const;
type PreviewName = (typeof PREVIEW_BUTTONS)[number];

const actions = new Map<PreviewName, Action>();

/** Sets what the preview buttons do. The handlers live in modules that depend on the preview, so they register here. */
export function registerPreviewActions(handlers: Record<PreviewName, Action>): void {
  for (const name of PREVIEW_BUTTONS) actions.set(name, handlers[name]);
}

/** A preview button: signed for the form's thread, without arguments or expiry. */
function previewButton(name: PreviewName): ButtonDefinition {
  return defineButton({
    name,
    bind: { channel: true },
    ephemeral: true,
    execute: async (ctx) => {
      const action = actions.get(name);
      if (action === undefined) throw new Error(`Preview button ${name} has no action.`);
      await action(ctx);
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
