import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import type { HandlerContext } from '../runtime/types.js';
import type { ModalPayload, Reply, Responder } from './responder.js';

/** Context of a handler answering an interaction; replies go through it, never through `interaction` directly. */
export interface InteractionContext<TConfig = any> extends HandlerContext<TConfig> {
  readonly channelId: string | null;
  /** Answers the interaction; later calls post follow-ups. */
  reply(message: Reply): Promise<void>;
  followUp(message: Reply): Promise<void>;
  /** Shows "thinking…". Commands slower than 2 s are deferred automatically. */
  defer(options?: { ephemeral?: boolean }): Promise<void>;
}

export interface CommandContext<TConfig = any> extends InteractionContext<TConfig> {
  readonly interaction: ChatInputCommandInteraction<'cached'>;
  /** Opens a modal; only allowed as the first answer. */
  showModal(modal: ModalPayload): Promise<void>;
}

export interface ButtonContext<TConfig = any> extends InteractionContext<TConfig> {
  readonly interaction: ButtonInteraction<'cached'>;
  showModal(modal: ModalPayload): Promise<void>;
}

export interface ModalContext<TConfig = any> extends InteractionContext<TConfig> {
  readonly interaction: ModalSubmitInteraction<'cached'>;
  /** The value of a text input in the submitted modal. */
  field(customId: string): string;
}

/** Adds the reply methods to a handler context; spreading keeps the handler's emit and queue working. */
export function interactionContext(ctx: HandlerContext, channelId: string | null, responder: Responder): InteractionContext {
  return {
    ...ctx,
    channelId,
    reply: (message) => responder.send(message),
    followUp: (message) => responder.send(message),
    defer: (options) => responder.defer(options?.ephemeral),
  };
}
