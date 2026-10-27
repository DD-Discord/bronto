import { defineButton, UserError, type ReplyMessage } from '@bronto/core';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { FormsContext } from './context.js';
import { fieldModalFor } from './editor.js';
import type { FieldInput } from './fields.js';
import type { FieldType } from './model.js';
import { formById, requireEditor } from './permissions.js';
import type { TryAgainError } from './save.js';
import { settingsModalFor, type SettingsInput } from './settings.js';

// Discord lets a bot edit an ephemeral reply for 15 minutes; editor components live as long.
export const EDITOR_TTL_MS = 15 * 60_000;
/** Binding of the components in ephemeral editor replies. */
export const editorBinding = { bind: { user: true, channel: true }, expiresAfterMs: EDITOR_TTL_MS, ephemeral: true } as const;

/** What a member typed into a modal that [Try again] fills back in. */
export type Draft =
  | { kind: 'field'; type: FieldType; fieldId: string | null; input: FieldInput }
  | { kind: 'settings'; input: SettingsInput };

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
    await ctx.showModal(draft.kind === 'field' ? fieldModalFor(ctx, form, draft.type, draft.fieldId, draft.input) : settingsModalFor(ctx, form, draft.input));
  },
});

/** The reason, with a [Try again] button that reopens the modal with what was typed. */
export function retryReply(ctx: FormsContext, formId: string, error: TryAgainError): ReplyMessage {
  const key = keepDraft(ctx.guildId, error.draft);
  const retry = new ButtonBuilder().setCustomId(ctx.customId(tryAgainButton, [formId, key])).setLabel('Try again').setStyle(ButtonStyle.Primary);
  return { content: error.message, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(retry)] };
}
