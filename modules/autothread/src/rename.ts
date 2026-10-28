import { defineButton, defineModal, UserError, type HandlerContext } from '@bronto/core';
import {
  ButtonStyle,
  ComponentType,
  LabelBuilder,
  ModalBuilder,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type APIActionRowComponent,
  type APIChannel,
  type APIComponentInMessageActionRow,
} from 'discord.js';

const MAX_NAME_LENGTH = 100;
/** Discord allows two renames per thread in ten minutes. */
const RENAMES = 2;
const WINDOW_MS = 600_000;

/** Counts the renames of each thread within Discord's window; in memory. */
export class RenameLimiter {
  private readonly renames = new Map<string, number[]>();

  /** Whether the thread has a rename left; records nothing. */
  allow(threadId: string, now: number): boolean {
    const recent = (this.renames.get(threadId) ?? []).filter((at) => at > now - WINDOW_MS);
    this.renames.set(threadId, recent);
    return recent.length < RENAMES;
  }

  /** Records a rename that went through. */
  record(threadId: string, now: number): void {
    this.renames.set(threadId, [...(this.renames.get(threadId) ?? []), now]);
  }

  /** When the thread can be renamed again, in milliseconds. */
  retryAt(threadId: string): number {
    return (this.renames.get(threadId)?.[0] ?? 0) + WINDOW_MS;
  }
}

export const NAME_INPUT = 'name';

/** The rename button and its modal, with the limiters of the guilds the module is running for. */
export function createRename() {
  const limiters = new Map<string, RenameLimiter>();
  const limiterOf = (guildId: string) => {
    let limiter = limiters.get(guildId);
    if (limiter === undefined) limiters.set(guildId, (limiter = new RenameLimiter()));
    return limiter;
  };

  const renameModal = defineModal({
    name: 'rename-modal',
    bind: { channel: true },
    ephemeral: true,
    execute: async (ctx) => {
      const threadId = ctx.channelId!;
      const name = ctx.interaction.fields.getTextInputValue(NAME_INPUT).trim();
      if (name === '') throw new UserError('Give the thread a name.');
      const limiter = limiterOf(ctx.guildId);
      if (!limiter.allow(threadId, Date.now())) {
        throw new UserError(`Discord allows two renames per 10 minutes. Try again <t:${Math.ceil(limiter.retryAt(threadId) / 1000)}:R>.`);
      }
      await ctx.client.rest.patch(Routes.channel(threadId), { body: { name } });
      limiter.record(threadId, Date.now());
      await ctx.reply('Thread renamed.');
    },
  });

  const renameButton = defineButton({
    name: 'rename',
    ephemeral: true,
    execute: async (ctx, args) => {
      if (ctx.actorId !== args[0]) throw new UserError('Only the author can rename this thread.');
      const threadId = ctx.channelId!;
      const cached = ctx.interaction.channel as { name?: unknown } | null | undefined;
      let current = typeof cached?.name === 'string' ? cached.name : undefined;
      if (current === undefined) {
        const thread = (await ctx.client.rest.get(Routes.channel(threadId))) as APIChannel;
        current = 'name' in thread && typeof thread.name === 'string' ? thread.name : '';
      }
      await ctx.showModal(
        new ModalBuilder()
          .setCustomId(ctx.customId(renameModal, [args[0]!]))
          .setTitle('Rename thread')
          .addLabelComponents(
            new LabelBuilder().setLabel('Name').setTextInputComponent(
              new TextInputBuilder()
                .setCustomId(NAME_INPUT)
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(MAX_NAME_LENGTH)
                .setRequired(true)
                .setValue([...current].slice(0, MAX_NAME_LENGTH).join('')),
            ),
          ),
      );
    },
  });

  /** The row with the "Rename thread" button for the author of a post. */
  const renameRow = (ctx: HandlerContext, authorId: string): APIActionRowComponent<APIComponentInMessageActionRow> => ({
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Rename thread', custom_id: ctx.customId(renameButton, [authorId]) }],
  });

  return { renameButton, renameModal, renameRow, dropGuild: (guildId: string) => limiters.delete(guildId) };
}

export type Rename = ReturnType<typeof createRename>;
