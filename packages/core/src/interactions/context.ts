import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
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

/** Component interactions can replace the message their component sits on. */
export interface UpdatableContext {
  /** Replaces the component's message; the first answer, after `deferUpdate`, or again after an update. */
  update(message: Reply): Promise<void>;
  /** Acknowledges without changing the message yet. Components slower than 2 s are deferred automatically. */
  deferUpdate(): Promise<void>;
}

export interface ButtonContext<TConfig = any> extends InteractionContext<TConfig>, UpdatableContext {
  readonly interaction: ButtonInteraction<'cached'>;
  showModal(modal: ModalPayload): Promise<void>;
}

export interface SelectContext<TConfig = any> extends InteractionContext<TConfig>, UpdatableContext {
  readonly interaction: StringSelectMenuInteraction<'cached'>;
  /** The options the user chose. */
  readonly values: string[];
  showModal(modal: ModalPayload): Promise<void>;
}

/** `update` and `deferUpdate` work only for modals submitted from a component's message. */
export interface ModalContext<TConfig = any> extends InteractionContext<TConfig>, UpdatableContext {
  readonly interaction: ModalSubmitInteraction<'cached'>;
  /** The value of a text input in the submitted modal. */
  field(customId: string): string;
}

/**
 * Adds the reply methods to a handler context; spreading keeps the handler's emit and queue working. Custom IDs default
 * to the interaction's channel.
 */
export function interactionContext(ctx: HandlerContext, channelId: string | null, responder: Responder): InteractionContext {
  return {
    ...ctx,
    channelId,
    customId: (component, args, target = {}) =>
      ctx.customId(component, args, { ...target, channelId: target.channelId ?? channelId ?? undefined }),
    reply: (message) => responder.send(message),
    followUp: (message) => responder.send(message),
    defer: (options) => responder.defer(options?.ephemeral),
  };
}
