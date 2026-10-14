import type { ClientEvents } from 'discord.js';
import type { HandlerContext } from './types.js';

/** A notification emitted by one module (or core); listeners match it by object identity. */
export interface EventDefinition<TPayload> {
  readonly name: string;
  /** Owning module, set by defineModule. */
  owner: string | null;
  /** Never set at runtime; carries the payload type. */
  readonly payload?: TPayload;
}

export function defineEvent<TPayload>(name: string): EventDefinition<TPayload> {
  return { name, owner: null };
}

export function eventLabel(event: EventDefinition<unknown>): string {
  return `${event.owner ?? 'unowned'}.${event.name}`;
}

export type DiscordEventName = keyof ClientEvents;

export type Listener =
  | { kind: 'discord'; event: DiscordEventName; handler: (ctx: HandlerContext, ...args: any[]) => unknown }
  | { kind: 'module'; event: EventDefinition<any>; handler: (ctx: HandlerContext, payload: any) => unknown };

/** Declares a listener for a Discord gateway event or a module event; modules list them in `listeners`. */
export function on<K extends DiscordEventName>(
  event: K,
  handler: (ctx: HandlerContext, ...args: ClientEvents[K]) => unknown,
): Listener;
export function on<P>(event: EventDefinition<P>, handler: (ctx: HandlerContext, payload: P) => unknown): Listener;
export function on(
  event: DiscordEventName | EventDefinition<unknown>,
  handler: (ctx: HandlerContext, ...args: any[]) => unknown,
): Listener {
  return typeof event === 'string' ? { kind: 'discord', event, handler } : { kind: 'module', event, handler };
}

function ownedByCore<P>(event: EventDefinition<P>): EventDefinition<P> {
  event.owner = 'core';
  return event;
}

/** Events core emits for any module to listen to. */
export const coreEvents = {
  guildJoined: ownedByCore(defineEvent<{ guildId: string }>('guildJoined')),
  guildLeft: ownedByCore(defineEvent<{ guildId: string }>('guildLeft')),
  moduleEnabled: ownedByCore(defineEvent<{ module: string }>('moduleEnabled')),
  moduleDisabled: ownedByCore(defineEvent<{ module: string }>('moduleDisabled')),
};
