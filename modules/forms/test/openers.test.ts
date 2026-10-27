import { fakeAutocomplete, fakeCommand, fakeSelect, FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { stickyEvents } from '@bronto/sticky';
import templates, { templatesEvents, templatesGates } from '@bronto/templates';
import { ChannelType, Events } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, openers, type Form } from '../src/db/schema.js';
import { allComponents, buttonId, click, makeForm, payload, selectOf, storeForum, toJson, textOf, type Json } from './ui.js';
import { formsDb, GUILD, inHandler, prepareFormsBot, ready, USER, type FormsBot } from './harness.js';

const TEXT = '100000000000000070';
const OTHER = '100000000000000071';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let fb: FormsBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  for (const id of [TEXT, OTHER]) discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
});

afterEach(async () => {
  await fb?.bot.stop();
  fb = undefined;
  await t.drop();
});

async function start(sticky: boolean): Promise<FormsBot> {
  fb = await prepareFormsBot(t, discord, { sticky });
  discord.addMember(GUILD, USER);
  await storeForum(t);
  await ready(fb);
  return fb;
}

async function activeForm(name = 'Story contest', active = true): Promise<Form> {
  const form = await makeForm(fb!, name);
  await formsDb(t).run(async (tx) => {
    await tx.update(forms).set({ active }).where(eq(forms.id, form.id));
  });
  return { ...form, active };
}

async function makeTemplate(name = 'Contest announcement', content = 'Join the contest.'): Promise<string> {
  return inHandler(fb!, async (ctx) => (await ctx.modules.get(templates).create({ name, content, embed: null })).id);
}

const channelOf = (id: string) => ({ id, isThread: () => false, parentId: null });

async function run(command: string, subcommand: string, options: Record<string, unknown>, channelId = TEXT): Promise<FakeInteraction> {
  const fake = fakeCommand({ command, subcommand, guildId: GUILD, channelId, userId: USER, options });
  fb!.client.emit(Events.InteractionCreate, fake);
  await fb!.bot.idle();
  return fake;
}

const post = (options: Record<string, unknown>) => run('forms', 'post', { channel: channelOf(TEXT), ...options });
const replyText = (fake: FakeInteraction) => String(payload(fake).content ?? '');

/** The messages of a channel as stored by the fake. */
function messagesIn(channelId: string): Json[] {
  return [...discord.messages.values()].filter((message) => message.channel_id === channelId).map((message) => toJson(message));
}

const buttonsOf = (message: Json) => allComponents(message.components).filter((component) => component.type === 2);
const openerRows = () => t.database.admin.select().from(openers).orderBy(openers.position);
const linkTo = (channelId: string, messageId: string) => `https://discord.com/channels/${GUILD}/${channelId}/${messageId}`;

/** Creates a sticky through its command; returns its template ID. */
async function makeSticky(channelId = TEXT): Promise<string> {
  const template = await makeTemplate('Sticky text', 'Read the rules.');
  const fake = await run('sticky', 'create', { channel: channelOf(channelId), template }, channelId);
  expect(fake.responses.length).toBeGreaterThan(0);
  return template;
}

async function say(channelId: string): Promise<void> {
  fb!.client.emit(Events.MessageCreate, {
    id: String(100000000000009000n + BigInt(Math.floor(Math.random() * 1e9))),
    channelId,
    guildId: GUILD,
    webhookId: null,
    system: false,
    author: { bot: false },
  } as never);
  await fb!.bot.idle();
}

const stickyPosts = () => fb!.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/webhooks/'));
const lastStickyButtons = () => {
  const body = stickyPosts().at(-1)!.body as { components: Json[] };
  return allComponents(body.components).filter((component) => component.type === 2);
};

describe('posting with a template', () => {
  it('posts the template with one button labelled as given', async () => {
    await start(false);
    const form = await activeForm();
    const template = await makeTemplate();
    const done = await post({ form: form.id, template, label: 'Apply now' });
    expect(replyText(done)).toContain('Posted');
    const [message] = messagesIn(TEXT);
    expect(message!.content).toBe('Join the contest.');
    expect(buttonsOf(message!)).toMatchObject([{ label: 'Apply now', disabled: false }]);
    const [row] = await openerRows();
    expect(row).toMatchObject({ formId: form.id, channelId: TEXT, messageId: message!.id, templateId: template, label: 'Apply now' });
  });

  it('labels the button with the form name by default', async () => {
    await start(false);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate() });
    expect(buttonsOf(messagesIn(TEXT)[0]!)).toMatchObject([{ label: 'Story contest' }]);
  });

  it('adds a second button to the same message by its link', async () => {
    await start(false);
    const first = await activeForm('Story contest');
    const second = await activeForm('Poetry slam');
    await post({ form: first.id, template: await makeTemplate(), label: 'Stories' });
    const [message] = messagesIn(TEXT);
    const done = await post({ form: second.id, message: linkTo(TEXT, String(message!.id)), label: 'Poems' });
    expect(replyText(done)).toContain('Added');
    expect(messagesIn(TEXT)).toHaveLength(1);
    expect(buttonsOf(messagesIn(TEXT)[0]!).map((button) => button.label)).toEqual(['Stories', 'Poems']);
    expect((await openerRows()).map((row) => row.position)).toEqual([0, 1]);
  });

  it('refuses a link to a message that holds no form buttons or lies in another channel', async () => {
    await start(false);
    const form = await activeForm();
    discord.addMessage(TEXT, '100000000000000500', { content: 'plain', authorId: USER });
    expect(replyText(await post({ form: form.id, message: linkTo(TEXT, '100000000000000500') }))).toContain('not a message with form buttons');
    await post({ form: form.id, template: await makeTemplate() });
    const id = String(messagesIn(TEXT)[0]!.id);
    expect(replyText(await post({ channel: channelOf(OTHER), form: form.id, message: linkTo(TEXT, id) }))).toContain('<#' + OTHER + '>');
    expect(replyText(await post({ form: form.id, message: 'nonsense' }))).toContain('link');
  });

  it('holds at most 25 buttons per message', async () => {
    await start(false);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate() });
    const message = messagesIn(TEXT)[0]!;
    await formsDb(t).run(async (tx) => {
      for (let i = 1; i < 25; i += 1) {
        await tx.insert(openers).values({ formId: form.id, channelId: TEXT, messageId: String(message.id), templateId: (await openerRows())[0]!.templateId, label: `B${i}`, position: i });
      }
    });
    const done = await post({ form: form.id, message: linkTo(TEXT, String(message.id)) });
    expect(replyText(done)).toContain('25');
    expect(await openerRows()).toHaveLength(25);
  });

  it('names a missing template or form', async () => {
    await start(false);
    const form = await activeForm();
    expect(replyText(await post({ form: form.id, template: '00000000-0000-4000-8000-000000000000' }))).toContain("template doesn't exist");
    expect(replyText(await post({ form: '00000000-0000-4000-8000-000000000000', template: await makeTemplate() }))).toContain("form doesn't exist");
    expect(messagesIn(TEXT)).toEqual([]);
  });

  it('suggests forms by name and templates', async () => {
    await start(false);
    await activeForm('Story contest');
    await activeForm('Poetry slam');
    await makeTemplate('Contest announcement');
    const suggest = async (focused: string, query: string) => {
      const fake = fakeAutocomplete({ command: 'forms', subcommand: 'post', focused, guildId: GUILD, channelId: TEXT, userId: USER, options: { [focused]: query } });
      fb!.client.emit(Events.InteractionCreate, fake);
      await fb!.bot.idle();
      return (fake.responses[0]!.payload as { name: string }[]).map((choice) => choice.name);
    };
    expect(await suggest('form', 'POET')).toEqual(['Poetry slam']);
    expect((await suggest('template', 'contest'))[0]).toContain('Contest announcement');
  });
});

describe('posting on a sticky', () => {
  it('adds the button to the sticky without a new message', async () => {
    await start(true);
    const form = await activeForm();
    await makeSticky();
    const before = messagesIn(TEXT).length;
    const done = await post({ form: form.id, label: 'Apply' });
    expect(replyText(done)).toContain('sticky');
    expect(messagesIn(TEXT)).toHaveLength(before);
    expect(await openerRows()).toMatchObject([{ channelId: TEXT, messageId: null, templateId: null, label: 'Apply' }]);
    await say(TEXT);
    expect(lastStickyButtons()).toMatchObject([{ label: 'Apply', disabled: false }]);
  });

  it('refreshes the live sticky right away', async () => {
    await start(true);
    const form = await activeForm();
    await makeSticky();
    await say(TEXT);
    const posted = discord.sent.length;
    await post({ form: form.id, label: 'Apply' });
    const edits = fb!.requests.filter((request) => request.method === 'PATCH' && request.path.startsWith('/webhooks/'));
    expect(edits).toHaveLength(1);
    expect(discord.sent.length).toBe(posted);
    expect(allComponents((edits[0]!.body as { components: Json[] }).components).filter((c) => c.type === 2)).toMatchObject([{ label: 'Apply' }]);
  });

  it('refuses without a sticky', async () => {
    await start(true);
    const form = await activeForm();
    const done = await post({ form: form.id });
    expect(replyText(done)).toBe(`Give a template, or create a sticky in <#${TEXT}> first.`);
    expect(await openerRows()).toEqual([]);
  });

  it('refuses the same way when sticky is not loaded', async () => {
    await start(false);
    const form = await activeForm();
    const done = await post({ form: form.id });
    expect(replyText(done)).toBe(`Give a template, or create a sticky in <#${TEXT}> first.`);
  });

  it('posts a template in a channel with a sticky and says the sticky reposts below', async () => {
    await start(true);
    const form = await activeForm();
    await makeSticky();
    const done = await post({ form: form.id, template: await makeTemplate() });
    expect(replyText(done)).toContain('sticky will repost below');
    expect(messagesIn(TEXT).some((message) => message.content === 'Join the contest.')).toBe(true);
  });

  it('removes the sticky buttons when the sticky is deleted', async () => {
    await start(true);
    const form = await activeForm();
    await makeSticky();
    await post({ form: form.id });
    await run('sticky', 'delete', { channel: channelOf(TEXT) });
    expect(await openerRows()).toEqual([]);
  });

  it('keeps message openers when a sticky is deleted', async () => {
    await start(true);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate() });
    await fb!.bot.dispatcher.runHandler(
      fb!.bot.runtimes.find((entry) => entry.name === 'sticky')!,
      GUILD,
      null,
      'test',
      async (ctx) => ctx.emit(stickyEvents.deleted, { channelId: TEXT }),
    );
    await fb!.bot.idle();
    expect(await openerRows()).toHaveLength(1);
  });
});

describe('form activity and name', () => {
  it('disables the buttons of an inactive form on both kinds', async () => {
    await start(true);
    const form = await activeForm('Story contest', true);
    await makeSticky();
    await post({ form: form.id, template: await makeTemplate(), label: 'On message' });
    await post({ form: form.id, label: 'On sticky' });
    await say(TEXT);
    expect(lastStickyButtons()[0]).toMatchObject({ disabled: false });
    await formsDb(t).run(async (tx) => {
      await tx.update(forms).set({ active: false }).where(eq(forms.id, form.id));
    });
    await inHandler(fb!, async (ctx) => (await import('../src/openers.js')).refreshOpeners(ctx, form.id));
    const message = messagesIn(TEXT).find((entry) => entry.content === 'Join the contest.')!;
    expect(buttonsOf(message)[0]).toMatchObject({ disabled: true });
    await say(TEXT);
    expect(lastStickyButtons()[0]).toMatchObject({ disabled: true });
  });

  it('removes the rows of a message that was deleted', async () => {
    await start(false);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate() });
    discord.messages.delete(String(messagesIn(TEXT)[0]!.id));
    await inHandler(fb!, async (ctx) => (await import('../src/openers.js')).refreshOpeners(ctx, form.id));
    expect(await openerRows()).toEqual([]);
  });
});

describe('templates', () => {
  /** Asks the templates gate as the templates module does when its Delete button is pressed. */
  async function checkDeleting(id: string) {
    let verdict;
    await fb!.bot.dispatcher.runHandler(fb!.bot.runtimes.find((entry) => entry.name === 'templates')!, GUILD, null, 'test', async (ctx) => {
      verdict = await ctx.check(templatesGates.deleting, { id });
    });
    return verdict!;
  }

  it('denies deleting a template an opener uses', async () => {
    await start(false);
    const form = await activeForm();
    const template = await makeTemplate();
    await post({ form: form.id, template });
    const verdict = await checkDeleting(template);
    expect(verdict).toMatchObject({ allowed: false, reasons: [`Used by form buttons in <#${TEXT}>`] });
    const free = await makeTemplate('Other', 'x');
    expect((await checkDeleting(free)).allowed).toBe(true);
  });

  async function emitTemplate(event: typeof templatesEvents.updated, id: string) {
    await fb!.bot.dispatcher.runHandler(fb!.bot.runtimes.find((entry) => entry.name === 'templates')!, GUILD, null, 'test', async (ctx) => ctx.emit(event, { id }));
    await fb!.bot.idle();
  }

  it('edits the opener message when the template changes', async () => {
    await start(false);
    const form = await activeForm();
    const template = await makeTemplate();
    await post({ form: form.id, template });
    await t.database.adminPool.query('update templates.templates set content = $2 where id = $1', [template, 'Join now.']);
    await emitTemplate(templatesEvents.updated, template);
    const [message] = messagesIn(TEXT);
    expect(message!.content).toBe('Join now.');
    expect(buttonsOf(message!)).toHaveLength(1);
  });

  it('deletes the opener message and rows when the template is deleted', async () => {
    await start(false);
    const form = await activeForm();
    const template = await makeTemplate();
    await post({ form: form.id, template });
    await emitTemplate(templatesEvents.deleted, template);
    expect(messagesIn(TEXT)).toEqual([]);
    expect(await openerRows()).toEqual([]);
  });
});

describe('/forms buttons', () => {
  it('lists the channel openers and removes one with the select', async () => {
    await start(true);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate(), label: 'Stories' });
    const id = String(messagesIn(TEXT)[0]!.id);
    await post({ form: form.id, message: linkTo(TEXT, id), label: 'Again' });
    const listed = await run('forms', 'buttons', { channel: channelOf(TEXT) });
    expect(textOf(payload(listed)) + String(payload(listed).content)).toContain('Stories');
    const select = selectOf(payload(listed));
    expect(select.options).toHaveLength(2);
    const removed = fakeSelect({ customId: select.custom_id, values: [select.options[1].value], guildId: GUILD, channelId: TEXT, userId: USER });
    fb!.client.emit(Events.InteractionCreate, removed);
    await fb!.bot.idle();
    expect(await openerRows()).toMatchObject([{ label: 'Stories' }]);
    expect(buttonsOf(messagesIn(TEXT)[0]!).map((button) => button.label)).toEqual(['Stories']);
  });

  it('deletes the message with its last button', async () => {
    await start(true);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate() });
    const listed = await run('forms', 'buttons', { channel: channelOf(TEXT) });
    const select = selectOf(payload(listed));
    fb!.client.emit(Events.InteractionCreate, fakeSelect({ customId: select.custom_id, values: [select.options[0].value], guildId: GUILD, channelId: TEXT, userId: USER }));
    await fb!.bot.idle();
    expect(messagesIn(TEXT)).toEqual([]);
    expect(await openerRows()).toEqual([]);
  });

  it('says so for a channel without buttons', async () => {
    await start(false);
    expect(replyText(await run('forms', 'buttons', { channel: channelOf(TEXT) }))).toContain('No form buttons');
  });
});

describe('open button', () => {
  it('answers privately that the form cannot be filled in yet', async () => {
    await start(false);
    const form = await activeForm();
    await post({ form: form.id, template: await makeTemplate() });
    const id = buttonId(messagesIn(TEXT)[0]!, 'Story contest');
    const clicked = await click(fb!, TEXT, id);
    expect(payload(clicked).content).toBe("This form can't be filled in yet.");
  });
});

describe('deleting a form', () => {
  it('deletes its opener messages and refreshes stickies before saying so', async () => {
    await start(true);
    const form = await activeForm();
    await makeSticky();
    await post({ form: form.id, template: await makeTemplate() });
    await post({ form: form.id, label: 'On sticky' });
    await say(TEXT);
    expect(lastStickyButtons()).toHaveLength(1);
    const { clickPreview } = await import('./ui.js');
    const ask = await clickPreview(fb!, discord, form.threadId, 'Delete');
    expect(String(payload(ask).content)).toContain('buttons');
    const done = await click(fb!, form.threadId, buttonId(payload(ask), 'Delete'));
    expect(JSON.stringify(payload(done))).toContain('Form deleted.');
    expect(messagesIn(TEXT).filter((message) => message.content === 'Join the contest.')).toEqual([]);
    expect(await openerRows()).toEqual([]);
    expect(discord.channels.has(form.threadId)).toBe(false);
    const edits = fb!.requests.filter((request) => request.method === 'PATCH' && request.path.startsWith('/webhooks/'));
    expect(edits.length).toBeGreaterThan(0);
    expect(allComponents((edits.at(-1)!.body as { components: Json[] }).components).filter((c) => c.type === 2)).toEqual([]);
  });

  it('does not say it is deleted when the delete fails', async () => {
    await start(false);
    const form = await activeForm();
    const { clickPreview } = await import('./ui.js');
    const ask = await clickPreview(fb!, discord, form.threadId, 'Delete');
    await formsDb(t).run(async (tx) => {
      await tx.delete(forms).where(eq(forms.id, form.id));
    });
    const done = await click(fb!, form.threadId, buttonId(payload(ask), 'Delete'));
    expect(JSON.stringify(done.responses.map((response) => response.payload))).not.toContain('Form deleted.');
  });
});
