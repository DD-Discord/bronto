import { defineEvent, defineGate } from '@bronto/core';

export const templatesEvents = {
  /** After each saved change to a template's content or embed; a rename doesn't fire it. */
  updated: defineEvent<{ id: string }>('updated'),
  /** After a template is deleted, however that happened. */
  deleted: defineEvent<{ id: string }>('deleted'),
};

export const templatesGates = {
  /** Asked by the Delete button before a template is deleted. */
  deleting: defineGate<{ id: string }>('deleting'),
};
