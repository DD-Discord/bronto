import { defineCollector, defineEvent } from '@bronto/core';
import { ComponentType, type APIActionRowComponent, type APIComponentInMessageActionRow } from 'discord.js';

const isButton = (component: unknown): boolean =>
  typeof component === 'object' && component !== null && (component as { type?: unknown }).type === ComponentType.Button;

/** An array of action rows, each holding one to five buttons. */
export function isActionRowArray(value: unknown): value is APIActionRowComponent<APIComponentInMessageActionRow>[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (typeof row !== 'object' || row === null || (row as { type?: unknown }).type !== ComponentType.ActionRow) return false;
      const components = (row as { components?: unknown }).components;
      return Array.isArray(components) && components.length >= 1 && components.length <= 5 && components.every(isButton);
    })
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
  /** A sticky was deleted: by command, because its template is gone or because its channel or thread was deleted. */
  deleted: defineEvent<{ channelId: string }>('deleted'),
};
