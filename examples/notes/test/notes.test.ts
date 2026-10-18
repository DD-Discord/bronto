import { createBot, type Bot } from '@bronto/core';
import { captureLog, fakeButton, fakeCommand, fakeModal, FakeClient, TEST_INTERACTION_SECRET } from '@bronto/core/testing';
import { Events, type ActionRowBuilder, type ButtonBuilder, type ModalBuilder } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import notesModule from '../src/index.js';
import { notes } from '../src/db/schema.js';

let t: TestDatabase;
let bot: Bot;
let client: FakeClient;

beforeEach(async () => {
  t = await createTestDatabase();
  client = new FakeClient();
  client.guilds.cache.set('g1', { id: 'g1', available: true });
  bot = createBot({
    config: {
      discord: { token: 'token' },
      database: { appUrl: t.appUrl, adminUrl: t.adminUrl },
      modules: {},
      interactions: { secret: TEST_INTERACTION_SECRET },
    },
    modules: [{ packageName: '@bronto/example-notes', definition: notesModule, config: {} }],
    database: t.database,
    client: client.asClient(),
    log: captureLog().log,
  });
  await bot.start();
  client.emit(Events.ClientReady, client);
  await bot.idle();
});

afterEach(async () => {
  await bot.stop();
  await t.drop();
});

async function send<T extends { responses: Array<{ kind: string; payload: unknown }> }>(fake: T): Promise<T> {
  client.emit(Events.InteractionCreate, fake);
  await bot.idle();
  return fake;
}

describe('example notes module', () => {
  it('registers /notes with the generated and custom subcommands', () => {
    const [, registered] = client.registered.get('g1') as Array<{ name: string; options: Array<{ name: string }> }>;
    expect(registered?.name).toBe('notes');
    expect(registered?.options.map((option) => option.name)).toEqual(['create', 'edit', 'show', 'list', 'delete', 'post', 'edit-text']);
  });

  it('creates, posts, reads and edits a note', async () => {
    const created = await send(fakeCommand({ command: 'notes', subcommand: 'create', options: { title: 'Rules', text: 'Be nice' } }));
    expect(created.responses[0]!.payload).toMatchObject({ content: '**Note created.**' });
    const [note] = await t.database.admin.select().from(notes);
    expect(note).toMatchObject({ title: 'Rules', body: 'Be nice', guildId: 'g1', createdBy: 'u1' });

    const posted = await send(fakeCommand({ command: 'notes', subcommand: 'post', options: { note: note!.id } }));
    const message = posted.responses[0]!.payload as { content: string; components: ActionRowBuilder<ButtonBuilder>[]; flags?: number };
    expect(message.content).toBe('**Rules**');
    expect(message.flags).toBeUndefined();
    const customId = (message.components[0]!.toJSON().components[0] as { custom_id: string }).custom_id;
    expect(customId).toMatch(new RegExp(`^notes:text:${note!.id}:[A-Za-z0-9_-]{11}$`));

    const read = await send(fakeButton({ customId, userId: 'u2' }));
    expect(read.responses[0]!.payload).toMatchObject({ content: 'Be nice' });

    const opened = await send(fakeCommand({ command: 'notes', subcommand: 'edit-text', options: { note: note!.id } }));
    expect(opened.responses[0]!.kind).toBe('showModal');
    const modal = (opened.responses[0]!.payload as ModalBuilder).toJSON();
    expect(modal.custom_id).toMatch(new RegExp(`^notes:text:${note!.id}:[A-Za-z0-9_-]{11}$`));
    expect(modal.title).toBe('Rules');

    // The form is bound to the user it was shown to.
    const stolen = await send(fakeModal({ customId: modal.custom_id, fields: { body: 'Be mean' }, userId: 'u3' }));
    expect(stolen.responses[0]!.payload).toMatchObject({ content: 'This no longer works.' });

    const saved = await send(fakeModal({ customId: modal.custom_id, fields: { body: 'Be very nice' } }));
    expect(saved.responses[0]!.payload).toMatchObject({ content: '**Note updated.**' });
    const [updated] = await t.database.admin.select().from(notes);
    expect(updated).toMatchObject({ body: 'Be very nice', updatedBy: 'u1' });
  });

  it('refuses buttons for notes that are gone', async () => {
    const posted = await send(fakeCommand({ command: 'notes', subcommand: 'create', options: { title: 'Gone', text: 'Soon' } }));
    expect(posted.responses[0]!.payload).toMatchObject({ content: '**Note created.**' });
    const [note] = await t.database.admin.select().from(notes).where(eq(notes.title, 'Gone'));
    const shown = await send(fakeCommand({ command: 'notes', subcommand: 'post', options: { note: note!.id } }));
    const message = shown.responses[0]!.payload as { components: ActionRowBuilder<ButtonBuilder>[] };
    const customId = (message.components[0]!.toJSON().components[0] as { custom_id: string }).custom_id;
    await send(fakeCommand({ command: 'notes', subcommand: 'delete', options: { note: note!.id } }));
    const read = await send(fakeButton({ customId }));
    expect(read.responses[0]!.payload).toMatchObject({ content: 'There is no such note.' });
  });
});
