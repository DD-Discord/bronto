import { defineButton, type ButtonDefinition } from '@bronto/core';
import { openAddField, openEditField } from './editor.js';
import { openSettings } from './settings.js';
import { askDelete, exportFormFile, openImport } from './transfer.js';

/** A preview button: signed for the form's thread, without arguments or expiry. */
function previewButton(name: string, execute: ButtonDefinition['execute']): ButtonDefinition {
  return defineButton({ name, bind: { channel: true }, ephemeral: true, execute });
}

export const addFieldButton = previewButton('add-field', (ctx) => openAddField(ctx));
export const editFieldButton = previewButton('edit-field', (ctx) => openEditField(ctx));
export const settingsButton = previewButton('settings', (ctx) => openSettings(ctx));
export const exportButton = previewButton('export', (ctx) => exportFormFile(ctx));
export const importButton = previewButton('import', (ctx) => openImport(ctx));
export const deleteButton = previewButton('delete', (ctx) => askDelete(ctx));

export const previewComponents = [addFieldButton, editFieldButton, settingsButton, exportButton, importButton, deleteButton];
