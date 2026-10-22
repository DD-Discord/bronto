import { randomUUID } from 'node:crypto';
import {
  crudSubcommands,
  defineButton,
  defineCommand,
  defineEntity,
  defineModal,
  defineModule,
  defineSubcommand,
  entityAutocomplete,
  opt,
  truncate,
  UserError,
  type HandlerContext,
} from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema.js';
import { notes } from './db/schema.js';

export const noteEntity = defineEntity({
  table: notes,
  key: 'id',
  displayName: { singular: 'Note', plural: 'Notes' },
  formatShort: (note) => note.title,
  formatFull: (note, base) => base().addFields({ name: 'Text', value: truncate(note.body, 1024) }),
});

const noteOption = opt.string({ description: 'The note', required: true, autocomplete: entityAutocomplete(noteEntity) });

async function findNote(ctx: HandlerContext, id: string) {
  const note = await noteEntity.find(ctx.db, id);
  if (note === null) throw new UserError('There is no such note.');
  return note;
}

/** Shows a posted note's text privately to whoever presses it. */
const readButton = defineButton({
  name: 'text',
  ephemeral: true,
  execute: async (ctx, [id]) => {
    const note = await findNote(ctx, id ?? '');
    await ctx.reply(note.body);
  },
});

/** Saves the text entered in the edit-text form. */
const textForm = defineModal({
  name: 'text',
  ephemeral: true,
  execute: async (ctx, [id]) => {
    const body = ctx.field('body');
    const [note] = await ctx.db.run(async (tx) => tx.update(notes).set({ body }).where(eq(notes.id, id ?? '')).returning());
    if (note === undefined) throw new UserError('There is no such note.');
    await ctx.reply({ content: '**Note updated.**', embeds: [await noteEntity.formatFull(note, ctx)] });
  },
});

const post = defineSubcommand({
  description: 'Posts a note in this channel with a button to read it',
  options: { note: noteOption },
  execute: async (ctx, { note: id }) => {
    const note = await findNote(ctx, id);
    const read = new ButtonBuilder().setCustomId(ctx.customId(readButton, [note.id])).setLabel('Read').setStyle(ButtonStyle.Secondary);
    await ctx.reply({ content: `**${note.title}**`, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(read)] });
  },
});

const editText = defineSubcommand({
  description: 'Edits the text of a note in a form',
  options: { note: noteOption },
  execute: async (ctx, { note: id }) => {
    const note = await findNote(ctx, id);
    const input = new TextInputBuilder().setCustomId('body').setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setValue(note.body);
    await ctx.showModal(
      new ModalBuilder()
        .setCustomId(ctx.customId(textForm, [note.id]))
        .setTitle(truncate(note.title, 45))
        .addLabelComponents(new LabelBuilder().setLabel('Text').setTextInputComponent(input)),
    );
  },
});

export default defineModule({
  name: 'notes',
  db: { schema, migrations: new URL('../drizzle/', import.meta.url) },
  commands: {
    notes: defineCommand({
      description: 'Shared notes of this server',
      permissions: PermissionFlagsBits.ManageMessages,
      subcommands: {
        ...crudSubcommands(noteEntity, {
          key: { name: 'note', option: opt.string({ description: 'The note' }), toKey: (id) => id, generate: () => randomUUID() },
          fields: {
            title: { option: opt.string({ description: 'Title', maxLength: 100 }), column: 'title' },
            text: { option: opt.string({ description: 'Text', maxLength: 2000 }), column: 'body' },
          },
        }),
        post,
        'edit-text': editText,
      },
    }),
  },
  components: [readButton, textForm],
});
