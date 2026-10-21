import {
  MessageFlags,
  type APIModalInteractionResponseCallbackData,
  type BaseMessageOptions,
  type InteractionDeferReplyOptions,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type JSONEncodable,
} from 'discord.js';

export const DONE = 'Done.';
export const GENERIC_FAILURE = 'Something went wrong. The error was logged.';

export interface ReplyMessage {
  content?: string;
  embeds?: BaseMessageOptions['embeds'];
  components?: BaseMessageOptions['components'];
  /** Visible only to the user. Ignored for the answer to a deferred interaction, which keeps the defer's visibility. */
  ephemeral?: boolean;
  /** Users and roles this message may ping; nobody by default. `@everyone` and `@here` never ping. */
  allowedMentions?: { users?: string[]; roles?: string[] };
  /** Message flags from `REPLY_FLAGS`, e.g. `MessageFlags.IsComponentsV2`. */
  flags?: number;
}

/** Flags a reply may set; visibility is chosen with `ephemeral`. */
export const REPLY_FLAGS = MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications | MessageFlags.IsComponentsV2;
// Discord accepts SuppressNotifications only on new messages, not on edits.
const EDIT_FLAGS = MessageFlags.SuppressEmbeds | MessageFlags.IsComponentsV2;

export type Reply = string | ReplyMessage;

export type ModalPayload = JSONEncodable<APIModalInteractionResponseCallbackData> | APIModalInteractionResponseCallbackData;

/** The interaction methods a Responder uses. */
export interface ResponseTarget {
  reply(options: InteractionReplyOptions): Promise<unknown>;
  deferReply(options: InteractionDeferReplyOptions): Promise<unknown>;
  /** Component interactions only: replaces the message the component is on. */
  update?(options: InteractionUpdateOptions): Promise<unknown>;
  deferUpdate?(): Promise<unknown>;
  editReply(options: InteractionEditReplyOptions): Promise<unknown>;
  followUp(options: InteractionReplyOptions): Promise<unknown>;
  deleteReply(): Promise<unknown>;
  showModal?(modal: ModalPayload): Promise<unknown>;
}

type State = 'open' | 'deferred' | 'deferredUpdate' | 'answered';

// Content can come from users (names, notes), so nothing pings unless the reply names who may be pinged.
function mentions(message: ReplyMessage): InteractionEditReplyOptions['allowedMentions'] {
  const allowed: { parse: []; users?: string[]; roles?: string[] } = { parse: [] };
  if (message.allowedMentions?.users !== undefined) allowed.users = [...message.allowedMentions.users];
  if (message.allowedMentions?.roles !== undefined) allowed.roles = [...message.allowedMentions.roles];
  return allowed;
}

function toMessage(reply: Reply): ReplyMessage {
  return typeof reply === 'string' ? { content: reply } : reply;
}

function body(message: ReplyMessage): InteractionEditReplyOptions {
  const options: InteractionEditReplyOptions = { allowedMentions: mentions(message) };
  if (message.content !== undefined) options.content = message.content;
  if (message.embeds !== undefined) options.embeds = message.embeds;
  if (message.components !== undefined) options.components = message.components;
  return options;
}

function replyFlags(message: ReplyMessage): number {
  const flags = message.flags ?? 0;
  if ((flags & ~REPLY_FLAGS) !== 0) {
    throw new Error('Reply flags may only combine SuppressEmbeds, SuppressNotifications and IsComponentsV2.');
  }
  return flags;
}

function withVisibility(message: ReplyMessage, ephemeral: boolean): InteractionReplyOptions {
  const options = body(message) as InteractionReplyOptions;
  const flags = replyFlags(message) | (ephemeral ? MessageFlags.Ephemeral : 0);
  if (flags !== 0) options.flags = flags;
  return options;
}

function editBody(message: ReplyMessage): InteractionEditReplyOptions {
  const options = body(message);
  const flags = replyFlags(message) & EDIT_FLAGS;
  if (flags !== 0) options.flags = flags;
  return options;
}

/** One interaction's answers, in order: at most one first answer (reply, defer or modal), then edits and follow-ups. */
export class Responder {
  private readonly target: ResponseTarget;
  private readonly ephemeral: boolean;
  private state: State = 'open';
  private deferredPrivately = false;
  private chain: Promise<unknown> = Promise.resolve();

  /** `ephemeral` is the default visibility of replies and defers. */
  constructor(target: ResponseTarget, ephemeral: boolean) {
    this.target = target;
    this.ephemeral = ephemeral;
  }

  send(reply: Reply): Promise<void> {
    return this.enqueue(async () => {
      const message = toMessage(reply);
      const ephemeral = message.ephemeral ?? this.ephemeral;
      if (this.state === 'open') {
        await this.target.reply(withVisibility(message, ephemeral));
      } else if (this.state === 'deferred') {
        await this.target.editReply(editBody(message));
      } else {
        await this.target.followUp(withVisibility(message, ephemeral));
      }
      this.state = 'answered';
    });
  }

  defer(ephemeral: boolean = this.ephemeral): Promise<void> {
    return this.enqueue(async () => {
      if (this.state !== 'open') return;
      await this.target.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      this.state = 'deferred';
      this.deferredPrivately = ephemeral;
    });
  }

  /** Replaces the message the component is on; the first answer, or the one after `deferUpdate`. */
  update(reply: Reply): Promise<void> {
    return this.enqueue(async () => {
      const options = editBody(toMessage(reply));
      if (this.state === 'open') {
        if (this.target.update === undefined) throw new Error('This interaction cannot update its message.');
        await this.target.update(options as InteractionUpdateOptions);
      } else if (this.state === 'deferredUpdate') {
        await this.target.editReply(options);
      } else {
        throw new Error('update must be the first answer or follow deferUpdate.');
      }
      this.state = 'answered';
    });
  }

  /** Acknowledges a component interaction without changing its message yet; `update` then edits it. */
  deferUpdate(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state !== 'open') return;
      if (this.target.deferUpdate === undefined) throw new Error('This interaction cannot update its message.');
      await this.target.deferUpdate();
      this.state = 'deferredUpdate';
    });
  }

  showModal(modal: ModalPayload): Promise<void> {
    return this.enqueue(async () => {
      if (this.state !== 'open') throw new Error('A modal can only be the first answer to an interaction.');
      if (this.target.showModal === undefined) throw new Error('This interaction cannot show a modal.');
      await this.target.showModal(modal);
      this.state = 'answered';
    });
  }

  /** Makes sure Discord got an answer after the handler finished. */
  finish(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === 'answered' || this.state === 'deferredUpdate') return;
      await this.answerPrivately(DONE);
    });
  }

  /** Tells the user something failed. */
  fail(message: string): Promise<void> {
    return this.enqueue(() => this.answerPrivately(message));
  }

  private async answerPrivately(content: string): Promise<void> {
    const message: ReplyMessage = { content, ephemeral: true };
    if (this.state === 'open') {
      await this.target.reply(withVisibility(message, true));
    } else if (this.state === 'deferred' && this.deferredPrivately) {
      await this.target.editReply(editBody(message));
    } else {
      // A public placeholder would turn the edit and the first follow-up public, so it is deleted first.
      if (this.state === 'deferred') await this.target.deleteReply();
      await this.target.followUp(withVisibility(message, true));
    }
    this.state = 'answered';
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
