import { defineGate } from '@bronto/core';

/** The post mediaonly is about to delete. */
export interface RemovingPayload {
  channelId: string;
  messageId: string;
  webhookId: string | null;
  authorId: string;
}

export const mediaonlyGates = {
  /** Asked before mediaonly deletes a post; a denial keeps the post, without notice, DM or report. */
  removing: defineGate<RemovingPayload>('removing'),
};
