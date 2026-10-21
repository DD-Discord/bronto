import { describe, expect, it } from 'vitest';
import { fakeAutocomplete, fakeButton, fakeCommand, fakeModal } from './interactions.js';

describe('fake interactions', () => {
  it('describes a subcommand with options', async () => {
    const channel = { id: 'c9' };
    const fake = fakeCommand({ command: 'notes', subcommand: 'create', options: { title: 'Hi', channel } });
    const interaction = fake.asInteraction();
    expect(interaction.isChatInputCommand()).toBe(true);
    expect(interaction.inCachedGuild()).toBe(true);
    if (!interaction.isChatInputCommand()) throw new Error('unreachable');
    expect(interaction.commandName).toBe('notes');
    expect(interaction.options.getSubcommand(false)).toBe('create');
    expect(interaction.options.getSubcommandGroup(false)).toBeNull();
    expect(interaction.options.get('title')?.value).toBe('Hi');
    expect(interaction.options.get('channel')?.channel).toBe(channel);
    expect(interaction.options.get('missing')).toBeNull();
    expect(interaction.user.id).toBe('u1');
    await interaction.reply({ content: 'ok' });
    expect(fake.responses).toEqual([{ kind: 'reply', payload: { content: 'ok' } }]);
    expect(interaction.replied).toBe(true);
  });

  it('tracks deferral and rejects responses on request', async () => {
    const fake = fakeCommand({ command: 'x', rejectResponses: true });
    const interaction = fake.asInteraction();
    if (!interaction.isChatInputCommand()) throw new Error('unreachable');
    await expect(interaction.deferReply({})).rejects.toThrow('Unknown interaction');
    expect(fake.responses).toEqual([]);
  });

  it('describes autocomplete, buttons and modals', async () => {
    const auto = fakeAutocomplete({ command: 'x', focused: 'name', options: { name: 'ab' } }).asInteraction();
    expect(auto.isAutocomplete()).toBe(true);
    if (!auto.isAutocomplete()) throw new Error('unreachable');
    expect(auto.options.getFocused(true)).toMatchObject({ name: 'name', value: 'ab' });

    const button = fakeButton({ customId: 'notes:copy:1', guildId: null }).asInteraction();
    expect(button.isButton()).toBe(true);
    expect(button.inCachedGuild()).toBe(false);

    const modal = fakeModal({ customId: 'notes:text:1', fields: { body: 'hello' } }).asInteraction();
    expect(modal.isModalSubmit()).toBe(true);
    if (!modal.isModalSubmit()) throw new Error('unreachable');
    expect(modal.fields.getTextInputValue('body')).toBe('hello');
  });

  it('reads uploaded files and checkboxes from a modal', async () => {
    const file = { id: '1', filename: 'a.png', url: 'https://cdn.discordapp.com/attachments/1/1/a.png' };
    const modal = fakeModal({
      customId: 'x', fields: {}, uploads: { image: [file], empty: [] }, checkboxes: { agree: true, other: false },
    }).asInteraction();
    if (!modal.isModalSubmit()) throw new Error('unreachable');
    expect(modal.fields.getUploadedFiles('image')?.first()).toMatchObject(file);
    expect(modal.fields.getUploadedFiles('image')?.get('1')?.name).toBe('a.png');
    expect(modal.fields.getUploadedFiles('empty')).toBeNull();
    expect(modal.fields.getCheckbox('agree')).toBe(true);
    expect(modal.fields.getCheckbox('other')).toBe(false);
    expect(() => modal.fields.getUploadedFiles('missing')).toThrow('No modal field missing');
    expect(() => modal.fields.getCheckbox('missing')).toThrow('No modal field missing');
  });

  it('carries the upload size limit, 10 MiB unless given', () => {
    expect(fakeModal({ customId: 'x' }).attachmentSizeLimit).toBe(10 * 1024 * 1024);
    expect(fakeModal({ customId: 'x', attachmentSizeLimit: 1024 }).attachmentSizeLimit).toBe(1024);
  });
});
