import { defineEvent } from '@bronto/core';

export const formsEvents = {
  /** After a form is deleted, however that happened. */
  deleted: defineEvent<{ id: string }>('deleted'),
};
