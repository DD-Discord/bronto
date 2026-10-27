import { FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { eq } from 'drizzle-orm';
import { forms, type Form } from '../src/db/schema.js';
import { refreshOpeners } from '../src/openers.js';
import { checkSettingsAllowed } from '../src/settings.js';
import { formsDb, GUILD, inHandler, prepareFormsBot, ready, type FormsBot } from './harness.js';
import { buttonId, click, clickPreview, makeForm, modalInputs, payload, shownModal, storeForum, storedForm, submitModal, textOf, toJson } from './ui.js';

vi.mock('../src/openers.js', () => ({ refreshOpeners: vi.fn(async () => undefined) }));

let t: TestDatabase;
let discord: FakeDiscordHttp;
let fb: FormsBot;
let form: Form;

const MEMBER = '100000000000000050';
const PLAIN_ROLE = '100000000000000060';
const OPEN_ROLE = '100000000000000061';
const SHOWN = '100000000000000070';
const HIDDEN = '100000000000000071';

beforeEach(async () => {
  vi.mocked(refreshOpeners).mockClear();
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  fb = await prepareFormsBot(t, discord);
  discord.addRole(GUILD, { id: PLAIN_ROLE, name: 'Judges' });
  discord.addRole(GUILD, { id: OPEN_ROLE, name: 'Readers' });
  discord.guilds.get(GUILD)!.roles.find((role) => role.id === OPEN_ROLE)!.mentionable = true;
  discord.addMember(GUILD, MEMBER);
  discord.addMember(GUILD, '100000000000000099');
  discord.addChannel(SHOWN, { guildId: GUILD, type: ChannelType.GuildText });
  discord.addChannel(HIDDEN, {
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionOverwrites: [{ id: GUILD, type: OverwriteType.Role, allow: '0', deny: String(PermissionFlagsBits.ViewChannel) } as never],
  });
  // The guild was cached when the client was created, before the roles and channels above existed.
  await fb.client.guilds.fetch({ guild: GUILD, force: true });
  await storeForum(t);
  await ready(fb);
  form = await makeForm(fb);
});

afterEach(async () => {
  await fb.bot.stop();
  await t.drop();
});

async function openSettings(who: { userId?: string } = {}) {
  const fake = await clickPreview(fb, discord, form.threadId, 'Settings', who);
  return shownModal(fake);
}

const memberOf = (id: string) => inHandler(fb, async (ctx) => (await ctx.client.guilds.fetch(GUILD)).members.fetch(id));

describe('settings modal', () => {
  it('shows the stored settings', async () => {
    const modal = await openSettings();
    const inputs = modalInputs(modal);
    expect(Object.keys(inputs)).toEqual(['name', 'channel', 'pings', 'roles', 'options']);
    expect(inputs.name!.value).toBe('Story contest');
    expect(inputs.options!.options.map((o: any) => [o.value, o.default ?? false])).toEqual([['active', false], ['once', true]]);
  });

  it('saves the settings and updates the preview', async () => {
    const modal = await openSettings();
    const done = await submitModal(fb, form.threadId, modal, {
      fields: { name: 'Poetry slam' },
      selections: { channel: [SHOWN], roles: [OPEN_ROLE], options: ['active'] },
      mentionables: { pings: { users: [MEMBER] } },
    });
    expect(payload(done).content).toContain('saved');
    const row = await storedForm(t, form.id);
    expect(row).toMatchObject({
      name: 'Poetry slam',
      active: true,
      oncePerMember: false,
      channelId: SHOWN,
      pingUserIds: [MEMBER],
      pingRoleIds: [],
      allowedRoleIds: [OPEN_ROLE],
    });
    expect(textOf(toJson(discord.messages.get(form.threadId)))).toContain('Poetry slam');
    expect(discord.channels.get(form.threadId)).toMatchObject({ name: 'Poetry slam' });
    expect(refreshOpeners).toHaveBeenCalledWith(expect.anything(), form.id);
  });

  it('leaves the openers alone when neither activity nor name changed', async () => {
    const modal = await openSettings();
    await submitModal(fb, form.threadId, modal, { selections: { channel: [SHOWN], roles: [], options: ['once'] }, mentionables: { pings: {} } });
    expect(refreshOpeners).not.toHaveBeenCalled();
  });

  it('refuses a role the member cannot mention and Try again keeps the input', async () => {
    const modal = await openSettings({ userId: MEMBER });
    const done = await submitModal(
      fb,
      form.threadId,
      modal,
      { fields: { name: 'Typed name' }, selections: { channel: [SHOWN], roles: [], options: [] }, mentionables: { pings: { roles: [PLAIN_ROLE] } } },
      { userId: MEMBER },
    );
    expect(payload(done).content).toContain('Judges');
    expect((await storedForm(t, form.id)).pingRoleIds).toEqual([]);
    const again = await click(fb, form.threadId, buttonId(payload(done), 'Try again'), { userId: MEMBER });
    expect(modalInputs(shownModal(again)).name!.value).toBe('Typed name');
  });

  it('saves over a stored ping role and channel the member could not set', async () => {
    await formsDb(t).run(async (tx) => {
      await tx.update(forms).set({ pingRoleIds: [PLAIN_ROLE], channelId: HIDDEN }).where(eq(forms.id, form.id));
    });
    const modal = await openSettings({ userId: MEMBER });
    const done = await submitModal(
      fb,
      form.threadId,
      modal,
      { selections: { channel: [HIDDEN], roles: [], options: ['active'] }, mentionables: { pings: { roles: [PLAIN_ROLE] } } },
      { userId: MEMBER },
    );
    expect(payload(done).content).toContain('saved');
    expect(await storedForm(t, form.id)).toMatchObject({ active: true, pingRoleIds: [PLAIN_ROLE], channelId: HIDDEN });
  });

  it('imports over a stored ping role and channel the member could not set', async () => {
    await formsDb(t).run(async (tx) => {
      await tx.update(forms).set({ pingRoleIds: [PLAIN_ROLE], channelId: HIDDEN }).where(eq(forms.id, form.id));
    });
    const json = JSON.stringify({ version: 1, settings: { name: 'Story contest', active: true, channelId: HIDDEN, pingUserIds: [], pingRoleIds: [PLAIN_ROLE], allowedRoleIds: [], oncePerMember: true }, fields: [] });
    const open = await clickPreview(fb, discord, form.threadId, 'Import', { userId: MEMBER });
    const done = await submitModal(fb, form.threadId, shownModal(open), { fields: { json }, uploads: { file: [] } }, { userId: MEMBER });
    expect(payload(done).content).toContain('imported');
    expect((await storedForm(t, form.id)).active).toBe(true);
  });

  it('refuses a channel the member cannot view', async () => {
    const modal = await openSettings({ userId: MEMBER });
    const done = await submitModal(
      fb,
      form.threadId,
      modal,
      { selections: { channel: [HIDDEN], roles: [], options: [] }, mentionables: { pings: {} } },
      { userId: MEMBER },
    );
    expect(payload(done).content).toContain(`<#${HIDDEN}>`);
    expect((await storedForm(t, form.id)).channelId).toBeNull();
  });
});

describe('checkSettingsAllowed', () => {
  const settings = (over: Partial<{ channelId: string | null; pingRoleIds: string[] }> = {}) => ({ channelId: null, pingRoleIds: [], ...over });

  it('allows a role mentionable by anyone, or any role for a member who can mention everyone', async () => {
    discord.guilds.get(GUILD)!.roles.find((r) => r.id === OPEN_ROLE)!.mentionable = true;
    discord.addMember(GUILD, '100000000000000051');
    expect(await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, await memberOf(MEMBER), settings({ pingRoleIds: [OPEN_ROLE] }), settings()))).toBeNull();
    const owner = await memberOf('100000000000000099');
    expect(await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, owner, settings({ pingRoleIds: [PLAIN_ROLE] }), settings()))).toBeNull();
  });

  it('refuses a role the member cannot mention, naming it', async () => {
    const reason = await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, await memberOf(MEMBER), settings({ pingRoleIds: [PLAIN_ROLE] }), settings()));
    expect(reason).toContain('Judges');
  });

  it('refuses to ping @everyone, even for the owner', async () => {
    const owner = await memberOf('100000000000000099');
    const reason = await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, owner, settings({ pingRoleIds: [GUILD] }), settings()));
    expect(reason).toContain('@everyone');
  });

  it('checks only ping roles and a channel that differ from the current ones', async () => {
    const current = { channelId: HIDDEN, pingRoleIds: [PLAIN_ROLE] };
    const member = await memberOf(MEMBER);
    expect(await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, member, current, current))).toBeNull();
    const added = await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, member, { channelId: HIDDEN, pingRoleIds: [PLAIN_ROLE] }, settings()));
    expect(added).toContain('Judges');
  });

  it('refuses a channel the member cannot view and one that does not exist', async () => {
    const hidden = await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, await memberOf(MEMBER), settings({ channelId: HIDDEN }), settings()));
    expect(hidden).toContain(`<#${HIDDEN}>`);
    const missing = await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, await memberOf(MEMBER), settings({ channelId: '100000000000000999' }), settings()));
    expect(missing).toContain('100000000000000999');
    expect(await inHandler(fb, async (ctx) => checkSettingsAllowed(ctx, await memberOf(MEMBER), settings({ channelId: SHOWN }), settings()))).toBeNull();
  });
});
