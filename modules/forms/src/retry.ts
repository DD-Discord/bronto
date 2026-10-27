import { defineButton, UserError, type ReplyMessage } from '@bronto/core';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ModalBuilder } from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { FormsContext } from './context.js';
import type { FieldInput, LimitsInput } from './fields.js';
import type { FieldType } from './model.js';
import { formById, requireEditor } from './permissions.js';
import type { Form } from './db/schema.js';
import { EDITOR_TTL_MS, editorBinding } from './binding.js';

/** What the settings modal holds. */
export interface SettingsInput {
  name: string;
  channelId: string | null;
  pingUserIds: string[];
  pingRoleIds: string[];
  allowedRoleIds: string[];
  active: boolean;
  oncePerMember: boolean;
}

/** What a member typed into a modal that [Try again] fills back in. */
export type Draft =
  | { kind: 'field'; type: FieldType; fieldId: string | null; input: FieldInput }
  | { kind: 'limits'; fieldId: string; input: LimitsInput }
  | { kind: 'settings'; input: SettingsInput };

/** Wrong input: the reply names the problem and offers [Try again] with what was typed. */
export class TryAgainError extends UserError {
  constructor(
    message: string,
    readonly draft: Draft,
  ) {
    super(message);
  }
}

type ModalFor = (ctx: FormsContext, form: Form, draft: never) => ModalBuilder;
const modalBuilders = new Map<Draft['kind'], ModalFor>();

/** Registers how [Try again] rebuilds the modal of a draft kind; the editor modules call it when they load. */
export function registerRetry<K extends Draft['kind']>(kind: K, build: (ctx: FormsContext, form: Form, draft: Extract<Draft, { kind: K }>) => ModalBuilder): void {
  modalBuilders.set(kind, build as ModalFor);
}

/**
 * Typed values by server and a random key, kept as long as editor components are valid. Module-level, so shared by
 * every instance of the module in the process: the components that use it are module-level definitions.
 */
const drafts = new Map<string, Map<string, { draft: Draft; expiresAt: number }>>();

function keepDraft(guildId: string, draft: Draft): string {
  const now = Date.now();
  const mine = drafts.get(guildId) ?? new Map();
  drafts.set(guildId, mine);
  for (const [key, entry] of mine) if (entry.expiresAt <= now) mine.delete(key);
  const key = randomBytes(6).toString('base64url');
  mine.set(key, { draft, expiresAt: now + EDITOR_TTL_MS });
  return key;
}

/** Drops the server's drafts; for `guildStopped`. */
export function dropDrafts(guildId: string): void {
  drafts.delete(guildId);
}

export const tryAgainButton = defineButton({
  name: 'try-again',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const entry = drafts.get(ctx.guildId)?.get(args[1] ?? '');
    if (entry === undefined || entry.expiresAt <= Date.now()) throw new UserError('That form has expired. Open the editor again.');
    const form = await formById(ctx, args[0] ?? '');
    const { draft } = entry;
    const build = modalBuilders.get(draft.kind);
    if (build === undefined) throw new Error(`No modal registered for ${draft.kind} drafts.`);
    await ctx.showModal((build as (c: FormsContext, f: Form, d: Draft) => ModalBuilder)(ctx, form, draft));
  },
});

/** The reason, with a [Try again] button that reopens the modal with what was typed. */
export function retryReply(ctx: FormsContext, formId: string, error: TryAgainError): ReplyMessage {
  const key = keepDraft(ctx.guildId, error.draft);
  const retry = new ButtonBuilder().setCustomId(ctx.customId(tryAgainButton, [formId, key])).setLabel('Try again').setStyle(ButtonStyle.Primary);
  return { content: error.message, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(retry)] };
}
