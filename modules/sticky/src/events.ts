import { defineEvent } from '@bronto/core';

export const stickyEvents = {
  /** A sticky was posted again. */
  posted: defineEvent<{ channelId: string; messageId: string }>('posted'),
};
