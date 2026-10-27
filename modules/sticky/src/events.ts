import { defineCollector, defineEvent } from '@bronto/core';
import { ComponentType, type APIActionRowComponent, type APIComponentInMessageActionRow } from 'discord.js';

/** An array of action rows, each with a `components` array. */
export function isActionRowArray(value: unknown): value is APIActionRowComponent<APIComponentInMessageActionRow>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        typeof row === 'object' && row !== null && (row as { type?: unknown }).type === ComponentType.ActionRow && Array.isArray((row as { components?: unknown }).components),
    )
  );
}

export const stickyAsks = {
  /** Rows to append below the sticky's template message. At most five rows are kept, in module order. */
  components: defineCollector<{ channelId: string }, APIActionRowComponent<APIComponentInMessageActionRow>[]>('components', {
    validate: isActionRowArray,
  }),
};

export const stickyEvents = {
  /** A sticky was posted again. */
  posted: defineEvent<{ channelId: string; messageId: string }>('posted'),
  /** A sticky was deleted, by command or because its template is gone. */
  deleted: defineEvent<{ channelId: string }>('deleted'),
};
