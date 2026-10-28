import { createScopedDb, moduleRoleName } from '@bronto/core';
import { fakeModal, type RecordedRequest } from '@bronto/core/testing';
import { ChannelType, Events, MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { rules as reactRules } from '../../autoreact/src/db/schema.js';
import { rules as threadRules } from '../../autothread/src/db/schema.js';
import { submissions } from '../src/db/schema.js';
import { fillKey, queued } from '../src/submit.js';
import { formsDb, GUILD, inHandler, USER } from './harness.js';
import {
  clickIn,
  contentOf,
  draftRows,
  fileField,
  formWith,
  messagesIn,
  open,
  openerId,
  openModal,
  PING_ROLE,
  replyOf,
  setForm,
  startFilling,
  submissionRows,
  SUBMIT,
  submitPage,
  text,
  TEXT,
  upload,
  type Filling,
} from './filling.js';
import { buttonId, shownModal, textOf, type Json } from './ui.js';

let t: TestDatabase;
let f: Filling;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await f?.fb.bot.stop();
  await t.drop();
});

const long = (letter: string) => `${letter.repeat(60)} `.repeat(50).trim();
const longFields = () => [text(1, { type: 'long' }), text(2, { type: 'long' }), text(3, { type: 'long' })];
const longAnswers = { q0000001: long('a'), q0000002: long('b'), q0000003: long('c') };

/** The JSON body of a message request; multipart requests carry it as `payload_json`. */
function bodyOf(request: RecordedRequest): Json {
  if (request.body instanceof FormData) return JSON.parse(String(request.body.get('payload_json')));
  return request.body as Json;
}

const postsTo = (channelId: string) => f.fb.requests.filter((request) => request.method === 'POST' && request.path === `/channels/${channelId}/messages`);

/** Makes the `n`th message sent to the channel fail with a server error, once. */
function failNth(channelId: string, n: number): void {
  const path = `/channels/${channelId}/messages`;
  let count = 0;
  const answer = async (request: RecordedRequest) => {
    count++;
    if (count === n) return { status: 500, json: { code: 0, message: 'Synthetic failure' } };
    f.discord.clearOverride('POST', path);
    try {
      return await f.discord.answer(request);
    } finally {
      if (count < n) f.discord.override('POST', path, answer);
    }
  };
  f.discord.override('POST', path, answer);
}

describe('submitting', () => {
  it('posts the parts to the form channel with pings only in the first', async () => {
    f = await startFilling(t);
    const form = await formWith(f, longFields(), { pingRoleIds: [PING_ROLE] });
    const done = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(done)).toContain('Submitted to **Story contest**.');
    const bodies = postsTo(SUBMIT).map(bodyOf);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) expect(body.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(bodies[0]!.allowed_mentions).toEqual({ parse: [], users: [], roles: [PING_ROLE] });
    for (const body of bodies.slice(1)) expect(body.allowed_mentions).toEqual({ parse: [] });
    const posted = messagesIn(f, SUBMIT).map(textOf).join('\n');
    for (const answer of Object.values(longAnswers)) expect(posted.replace(/\n\*\*Question \d \(continued\)\*\*\n/g, ' ')).toContain(answer.slice(0, 500));
    const [row] = await submissionRows(f);
    expect(row).toMatchObject({ status: 'posted', userId: USER, once: true });
    expect(row!.partMessageIds).toEqual(messagesIn(f, SUBMIT).map((message) => message.id));
    expect(await draftRows(f)).toEqual([]);
  });

  it('attaches uploaded files and deletes the draft files after posting', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1), fileField(1)]);
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'Hello' }, uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    const [message] = messagesIn(f, SUBMIT);
    expect(message!.attachments.map((a: Json) => a.filename)).toEqual(['1-cover.png']);
    const drafted = [...f.discord.messages.values()].filter((m) => m.attachments.length > 0 && m.channel_id !== SUBMIT);
    expect(drafted).toEqual([]);
    const [row] = await submissionRows(f);
    expect(row!.files[0]).toMatchObject({ messageId: message!.id, name: 'cover.png' });
  });

  it('two final submits post once', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)]);
    const modal = await openModal(f, await openerId(f, form));
    const submits = [0, 1].map(() =>
      fakeModal({ customId: modal.custom_id, guildId: GUILD, channelId: TEXT, userId: USER, fields: { q0000001: 'Twice' } }),
    );
    for (const fake of submits) f.fb.client.emit(Events.InteractionCreate, fake as never);
    await f.fb.bot.idle();
    expect(await submissionRows(f)).toHaveLength(1);
    expect(messagesIn(f, SUBMIT)).toHaveLength(1);
    const replies = submits.map((fake) => contentOf(fake, fake.responses.length - 1));
    expect(replies.filter((reply) => reply.startsWith('Submitted to'))).toHaveLength(1);
    expect(replies).toContain('You already submitted this form.');
  });

  it('refuses a final submit on an inactive form and keeps the draft', async () => {
    f = await startFilling(t);
    const fields = [1, 2, 3, 4, 5, 6].map((n) => text(n));
    const form = await formWith(f, fields);
    const opener = await openerId(f, form);
    const saved = await submitPage(f, await openModal(f, opener), { fields: { q0000001: 'One' } });
    const last = shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)'));
    await setForm(f, form.id, { active: false });
    const refused = await submitPage(f, last, { fields: { q0000006: 'Six' } });
    expect(contentOf(refused)).toBe('This form is currently closed.');
    buttonId(replyOf(refused), 'Cancel');
    expect(await submissionRows(f)).toEqual([]);
    const [draft] = await draftRows(f);
    expect(draft!.answers).toMatchObject({ q0000001: { text: 'One' }, q0000006: { text: 'Six' } });
    await setForm(f, form.id, { active: true });
    const again = await openModal(f, opener);
    expect(again.title).toBe('Story contest (2/2)');
    expect(contentOf(await submitPage(f, again))).toContain('Submitted to');
  });

  it('offers Try again when a part fails and then posts only the rest', async () => {
    f = await startFilling(t);
    const form = await formWith(f, longFields());
    failNth(SUBMIT, 2);
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    const [row] = await submissionRows(f);
    expect(row).toMatchObject({ status: 'posting' });
    expect(row!.partMessageIds).toHaveLength(1);
    expect(await draftRows(f)).toHaveLength(1);
    const before = messagesIn(f, SUBMIT).length;
    expect(before).toBe(1);

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    const posted = messagesIn(f, SUBMIT);
    const [done] = await submissionRows(f);
    expect(done!.status).toBe('posted');
    expect(done!.partMessageIds).toEqual(posted.map((message) => message.id));
    expect(textOf(posted[1]!)).toContain(`part 2 of ${posted.length}`);
    expect(textOf(posted[0]!)).toContain('## Story contest');
    expect(posted.filter((message) => textOf(message).includes('## Story contest'))).toHaveLength(1);
    expect(await draftRows(f)).toEqual([]);
  });

  it('accepts a second submission when the form allows many', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)], { oncePerMember: false });
    const opener = await openerId(f, form);
    await submitPage(f, await openModal(f, opener), { fields: { q0000001: 'First' } });
    await submitPage(f, await openModal(f, opener), { fields: { q0000001: 'Second' } });
    expect(await submissionRows(f)).toHaveLength(2);
    expect(messagesIn(f, SUBMIT)).toHaveLength(2);
  });

  it('drops files of removed fields and says so', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1), ...[1, 2, 3, 4, 5].map((n) => text(n))]);
    const opener = await openerId(f, form);
    await submitPage(f, await openModal(f, opener), { uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    // The field goes without the editor, so the draft still holds its file.
    await setForm(f, form.id, { fields: [1, 2, 3, 4, 5].map((n) => text(n)) });
    const done = await submitPage(f, await openModal(f, opener));
    expect(contentOf(done)).toContain('Submitted to');
    expect(contentOf(done)).toContain("These files weren't posted: cover.png (its field was removed).");
    expect(messagesIn(f, SUBMIT)[0]!.attachments).toEqual([]);
  });

  it('posts without a draft file deleted by hand and names it', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1), ...[1, 2, 3, 4, 5].map((n) => text(n))]);
    const opener = await openerId(f, form);
    const saved = await submitPage(f, await openModal(f, opener), { uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    const [draft] = await draftRows(f);
    f.discord.messages.delete(draft!.files[0]!.messageId);
    const done = await submitPage(f, shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)')));
    expect(contentOf(done)).toContain("These files weren't posted: cover.png (no longer available).");
    expect(contentOf(done)).not.toContain('**Files 1:**');
    const [row] = await submissionRows(f);
    expect(row!.status).toBe('posted');
    expect(messagesIn(f, SUBMIT)).toHaveLength(1);
  });

  it('a retry posts the stored parts after the fields were edited', async () => {
    f = await startFilling(t);
    const form = await formWith(f, longFields());
    failNth(SUBMIT, 2);
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    const [before] = await submissionRows(f);
    const stored = before!.render.parts;
    expect(stored.length).toBeGreaterThan(2);
    await setForm(f, form.id, { fields: [text(1, { type: 'long', label: 'Renamed' }), text(2, { type: 'long' }), text(4)] });
    await clickIn(f, replyOf(failed), 'Try again');
    const posted = messagesIn(f, SUBMIT);
    expect(posted).toHaveLength(stored.length);
    posted.forEach((message, index) => expect(message.components).toEqual(JSON.parse(JSON.stringify(stored[index]!.components))));
    const all = posted.map(textOf).join('\n');
    expect(all).not.toContain('Renamed');
    expect(all).toContain('Question 3');
  });

  it('Discard before any part was posted deletes the submission and keeps the draft', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)]);
    const opener = await openerId(f, form);
    failNth(SUBMIT, 1);
    await submitPage(f, await openModal(f, opener), { fields: { q0000001: 'Kept' } });
    const refused = await open(f, opener);
    expect(contentOf(refused)).toContain("isn't fully posted yet");
    const discarded = await clickIn(f, replyOf(refused), 'Discard');
    expect(contentOf(discarded)).toContain('Discarded.');
    expect(await submissionRows(f)).toEqual([]);
    const [draft] = await draftRows(f);
    expect(draft!.answers.q0000001).toEqual({ text: 'Kept' });
    expect(messagesIn(f, SUBMIT)).toEqual([]);
  });

  it('Discard after some parts counts the submission as posted and names the missing parts', async () => {
    f = await startFilling(t);
    const form = await formWith(f, longFields());
    failNth(SUBMIT, 2);
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    const [row] = await submissionRows(f);
    const total = row!.render.parts.length;
    const discarded = await clickIn(f, replyOf(failed), 'Discard');
    expect(contentOf(discarded)).toContain(`Parts 2–${total} of ${total} weren't posted.`);
    const [done] = await submissionRows(f);
    expect(done!.status).toBe('posted');
    expect(await draftRows(f)).toEqual([]);
    expect(messagesIn(f, SUBMIT)).toHaveLength(1);
  });

  it('a repeated submit of one modal posts once on a form allowing many submissions', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)], { oncePerMember: false });
    const opener = await openerId(f, form);
    const modal = await openModal(f, opener);
    const submits = [0, 1].map(() => fakeModal({ customId: modal.custom_id, guildId: GUILD, channelId: TEXT, userId: USER, fields: { q0000001: 'Twice' } }));
    for (const fake of submits) f.fb.client.emit(Events.InteractionCreate, fake as never);
    await f.fb.bot.idle();
    expect(await submissionRows(f)).toHaveLength(1);
    expect(submits.map((fake) => contentOf(fake, fake.responses.length - 1))).toContain('You already submitted this form.');
    expect(await draftRows(f)).toEqual([]);
    await submitPage(f, await openModal(f, opener), { fields: { q0000001: 'Again' } });
    expect(await submissionRows(f)).toHaveLength(2);
  });
});

/** The draft-file messages: messages with attachments outside the channels the tests use. */
const draftFileMessages = () => [...f.discord.messages.values()].filter((message) => message.attachments.length > 0 && message.channel_id !== TEXT && message.channel_id !== SUBMIT);

describe('refusing a page', () => {
  it('refuses an old Continue while the submission is posting and keeps its files', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [...[1, 2, 3, 4, 5].map((n) => text(n)), fileField(1)]);
    const saved = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'One' } });
    const last = shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)'));
    failNth(SUBMIT, 1);
    expect(contentOf(await submitPage(f, last, { uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } }))).toContain("couldn't post");
    const again = shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)'));
    const refused = await submitPage(f, again, { uploads: { f0000001: [upload(f, 'other.png', 'other bytes')] } });
    expect(contentOf(refused)).toContain("isn't fully posted yet");
    const [draft] = await draftRows(f);
    expect(draft!.files.map((file) => file.name)).toEqual(['cover.png']);
    expect(draftFileMessages()).toHaveLength(1);
    const retried = await clickIn(f, replyOf(refused), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to');
    expect(messagesIn(f, SUBMIT)[0]!.attachments.map((a: Json) => a.filename)).toEqual(['1-cover.png']);
  });

  it('a file of an earlier page over the limit offers Try again on that page and Cancel', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1), ...[1, 2, 3, 4, 5].map((n) => text(n))]);
    const opener = await openerId(f, form);
    const saved = await submitPage(f, await openModal(f, opener), { uploads: { f0000001: [upload(f, 'big.png', 3 * 1024 * 1024)] } }, { attachmentSizeLimit: 8 * 1024 * 1024 });
    const last = shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)'));
    const refused = await submitPage(f, last, {}, { attachmentSizeLimit: 2 * 1024 * 1024 });
    expect(contentOf(refused)).toContain('big.png is larger than 2 MB');
    expect(await submissionRows(f)).toEqual([]);
    const retried = shownModal(await clickIn(f, replyOf(refused), 'Try again'));
    expect(retried.title).toBe('Story contest (1/2)');
    await clickIn(f, replyOf(refused), 'Cancel');
    expect(await draftRows(f)).toEqual([]);
    expect(draftFileMessages()).toEqual([]);
  });

  it('offers Cancel when a once-per-member form was submitted meanwhile', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [1, 2, 3, 4, 5, 6].map((n) => text(n)));
    const saved = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'One' } });
    const last = shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)'));
    await formsDb(t).run(async (tx) => {
      await tx.insert(submissions).values({ formId: form.id, userId: USER, answers: {}, channelId: SUBMIT, status: 'posted', once: true, render: { fields: [], parts: [], dropped: [] } });
    });
    const refused = await submitPage(f, last);
    expect(contentOf(refused)).toBe('You already submitted this form.');
    await clickIn(f, replyOf(refused), 'Cancel');
    expect(await draftRows(f)).toEqual([]);
  });
});

describe('the member queue', () => {
  it('runs work that a newer task replaced while it waited', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)]);
    const results = await inHandler(f.fb, async (ctx) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = ctx.queue.run(fillKey(form.id, USER), () => blocked);
      const first = queued(ctx, form.id, USER, async () => 'first');
      const second = queued(ctx, form.id, USER, async () => 'second');
      release();
      await running;
      return Promise.all([first, second]);
    });
    expect(results).toEqual(['first', 'second']);
  });

  it('Cancel says the draft was deleted only after deleting it', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [1, 2, 3, 4, 5, 6].map((n) => text(n)));
    const saved = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'One' } });
    const cancelled = await clickIn(f, replyOf(saved), 'Cancel');
    expect(contentOf(cancelled)).toBe('Cancelled. Your answers and files were deleted.');
    expect(await draftRows(f)).toEqual([]);
  });
});

describe("the form's post as the default channel", () => {
  it("posts into the form's own post when no channel is set", async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)], { channelId: null });
    const done = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'Hello' } });
    expect(contentOf(done)).toContain('Submitted to **Story contest**.');
    expect(postsTo(SUBMIT)).toHaveLength(0);
    expect(messagesIn(f, form.threadId).map(textOf).join('\n')).toContain('Hello');
    expect((await submissionRows(f))[0]).toMatchObject({ status: 'posted', channelId: form.threadId });
  });

  it('unarchives an archived post before posting and leaves it unlocked', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)], { channelId: null });
    const opener = await openerId(f, form);
    const modal = await openModal(f, opener);
    const thread = (await f.fb.client.channels.fetch(form.threadId)) as import('discord.js').ThreadChannel;
    await thread.setArchived(true);
    expect(f.discord.channels.get(form.threadId)).toMatchObject({ thread_metadata: { archived: true } });
    await submitPage(f, modal, { fields: { q0000001: 'Hello' } });
    expect(f.discord.channels.get(form.threadId)).toMatchObject({ thread_metadata: { archived: false, locked: false } });
    expect(messagesIn(f, form.threadId).map(textOf).join('\n')).toContain('Hello');
  });

  it('still posts into a chosen channel', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)]);
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'Hello' } });
    expect(messagesIn(f, SUBMIT).map(textOf).join('\n')).toContain('Hello');
    expect(messagesIn(f, form.threadId).map(textOf).join('\n')).not.toContain('Hello');
  });
});

describe('a missing target', () => {
  it('says the channel or post no longer exists and offers Try again and Discard', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)]);
    const modal = await openModal(f, await openerId(f, form));
    f.discord.channels.delete(SUBMIT);
    const done = await submitPage(f, modal, { fields: { q0000001: 'Hello' } });
    expect(contentOf(done)).toContain("the submissions channel or the form's post no longer exists.");
    buttonId(replyOf(done), 'Try again');
    buttonId(replyOf(done), 'Discard');
    expect((await submissionRows(f))[0]).toMatchObject({ status: 'posting' });
  });
});

/** Makes the next request to `method path` fail with a server error, once. */
function failOnce(method: string, path: string): void {
  f.discord.override(method, path, () => {
    f.discord.clearOverride(method, path);
    return { status: 500, json: { code: 0, message: 'Synthetic failure' } };
  });
}

/** Calls `then` with the ID of the next message sent to the channel. */
function onNextPost(channelId: string, then: (id: string) => void): void {
  const path = `/channels/${channelId}/messages`;
  f.discord.override('POST', path, async (request) => {
    f.discord.clearOverride('POST', path);
    const response = await f.discord.answer(request);
    then((response.json as { id: string }).id);
    return response;
  });
}

/** Runs a module's start-up hook again, so that it loads rules inserted meanwhile. */
async function reload(name: string): Promise<void> {
  const runtime = f.fb.bot.runtimes.find((entry) => entry.name === name)!;
  const outcome = await f.fb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
    await runtime.loaded.definition.hooks?.guildReady?.(ctx as never);
  });
  if (!outcome.ok) throw outcome.error;
}

const moduleDb = (name: string) => createScopedDb(t.database.app, GUILD, moduleRoleName(t.database.appRole, name));

/** An autothread rule for SUBMIT, loaded right away. */
async function threadRule(values: Partial<typeof threadRules.$inferInsert> = {}): Promise<void> {
  await moduleDb('autothread').run(async (tx) => {
    await tx.insert(threadRules).values({ channelId: SUBMIT, ...values });
  });
  await reload('autothread');
}

/** An autoreact rule adding a thumbs-up, for SUBMIT unless `channelId` says otherwise, loaded right away. */
async function reactRule(channelId = SUBMIT): Promise<void> {
  await moduleDb('autoreact').run(async (tx) => {
    await tx.insert(reactRules).values({ channelId, emojis: ['\u{1F44D}'] });
  });
  await reload('autoreact');
}

const threadRequests = () => f.fb.requests.filter((request) => request.method === 'POST' && /\/messages\/\d+\/threads$/.test(request.path));
const reactedOn = () => f.discord.reactions.map((reaction) => reaction.messageId);

describe('threads and reactions', () => {
  it('opens a thread on part 1 and posts the rest in it', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule({ rename: true });
    await reactRule();
    const form = await formWith(f, longFields());
    const done = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(done)).toContain('Submitted to **Story contest**.');
    const [first, ...others] = messagesIn(f, SUBMIT);
    expect(others).toEqual([]);
    expect(f.discord.channels.get(first!.id)).toMatchObject({ parent_id: SUBMIT, name: '[Comments] User 099' });
    const [autoMessage, ...rest] = messagesIn(f, first!.id);
    expect(autoMessage!.content).toBe('The author of this post can rename the thread.');
    const [row] = await submissionRows(f);
    expect(row!.status).toBe('posted');
    expect(row!.partMessageIds).toEqual([first!.id, ...rest.map((message) => message.id)]);
    expect(rest.length).toBeGreaterThan(1);
    expect(textOf(rest[0]!)).toContain(`part 2 of ${rest.length + 1}`);
    expect(f.discord.reactions).toEqual([{ messageId: first!.id, emoji: '\u{1F44D}' }]);
  });

  it('posts as today without rules', async () => {
    f = await startFilling(t, [], { postRules: true });
    const form = await formWith(f, longFields());
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toEqual(messagesIn(f, SUBMIT).map((message) => message.id));
    expect(row!.partMessageIds.length).toBeGreaterThan(1);
    expect(threadRequests()).toEqual([]);
    expect(f.discord.reactions).toEqual([]);
  });

  it("posts as today when the modules aren't loaded", async () => {
    f = await startFilling(t);
    const form = await formWith(f, longFields());
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    const [row] = await submissionRows(f);
    expect(row!.status).toBe('posted');
    expect(row!.partMessageIds).toEqual(messagesIn(f, SUBMIT).map((message) => message.id));
    expect(threadRequests()).toEqual([]);
  });

  it("posts as today into the form's own post", async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    await reactRule();
    const form = await formWith(f, longFields(), { channelId: null });
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    const [row] = await submissionRows(f);
    expect(row!.status).toBe('posted');
    const posted = messagesIn(f, form.threadId).filter((message) => row!.partMessageIds.includes(message.id));
    expect(posted.map((message) => message.id)).toEqual(row!.partMessageIds);
    expect(threadRequests()).toEqual([]);
    expect(f.discord.reactions).toEqual([]);
  });

  it("adds reactions in the form's own post but opens no thread there", async () => {
    f = await startFilling(t, [], { postRules: true });
    const form = await formWith(f, longFields(), { channelId: null });
    await threadRule({ channelId: form.threadId });
    await reactRule(form.threadId);
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    const [row] = await submissionRows(f);
    expect(row!.status).toBe('posted');
    expect(row!.partMessageIds.length).toBeGreaterThan(1);
    expect(messagesIn(f, form.threadId).filter((message) => row!.partMessageIds.includes(message.id))).toHaveLength(row!.partMessageIds.length);
    expect(reactedOn()).toEqual([row!.partMessageIds[0]]);
    expect(threadRequests()).toEqual([]);
  });

  it('a retry in a thread submissions channel stays there without looking for a thread', async () => {
    f = await startFilling(t, [], { postRules: true });
    const form = await formWith(f, longFields(), { channelId: null });
    await threadRule({ channelId: form.threadId });
    failNth(form.threadId, 2);
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    const [before] = await submissionRows(f);
    const part1Id = before!.partMessageIds[0]!;

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toHaveLength(row!.render.parts.length);
    expect(messagesIn(f, form.threadId).filter((message) => row!.partMessageIds.includes(message.id))).toHaveLength(row!.partMessageIds.length);
    expect(f.fb.requests.filter((request) => request.method === 'GET' && request.path === `/channels/${part1Id}`)).toEqual([]);
    expect(threadRequests()).toEqual([]);
  });

  it('uses the account when the submitter left', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    Object.assign(f.discord.users.get(USER)!, { global_name: 'Mia Account', avatar: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5' });
    f.discord.members.delete(`${GUILD}:${USER}`);
    const form = await formWith(f, [text(1)]);
    await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'Hello' } });
    const [first] = messagesIn(f, SUBMIT);
    expect(JSON.stringify(first!.components)).toContain(`/avatars/${USER}/a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5`);
    expect(f.discord.channels.get(first!.id)).toMatchObject({ name: '[Comments] Mia Account' });
  });

  it('a retry after a failed thread opens it and posts the rest there', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    await reactRule();
    const form = await formWith(f, longFields());
    onNextPost(SUBMIT, (id) => failOnce('POST', `/channels/${SUBMIT}/messages/${id}/threads`));
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    const [first] = messagesIn(f, SUBMIT);
    expect(f.discord.channels.has(first!.id)).toBe(false);
    expect((await submissionRows(f))[0]!.partMessageIds).toEqual([first!.id]);

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    expect(messagesIn(f, SUBMIT)).toHaveLength(1);
    expect(f.discord.channels.get(first!.id)).toMatchObject({ parent_id: SUBMIT });
    const inThread = messagesIn(f, first!.id);
    expect(inThread.length).toBeGreaterThan(1);
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toEqual([first!.id, ...inThread.map((message) => message.id)]);
    expect(reactedOn()).toEqual([first!.id]);
  });

  it('a retry continues in an archived thread', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    const form = await formWith(f, longFields());
    onNextPost(SUBMIT, (id) => failNth(id, 2));
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    const [first] = messagesIn(f, SUBMIT);
    expect(messagesIn(f, first!.id)).toHaveLength(1);
    Object.assign(f.discord.channels.get(first!.id)!, { thread_metadata: { archived: true, locked: false, auto_archive_duration: 60, archive_timestamp: '2026-01-01T00:00:00Z' } });

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    const unarchived = f.fb.requests.filter((request) => request.method === 'PATCH' && request.path === `/channels/${first!.id}`);
    expect(unarchived.map(bodyOf)).toEqual([expect.objectContaining({ archived: false })]);
    const inThread = messagesIn(f, first!.id);
    expect(textOf(inThread[1]!)).toContain('part 3 of');
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toEqual([first!.id, ...inThread.map((message) => message.id)]);
    expect(messagesIn(f, SUBMIT)).toHaveLength(1);
  });

  it('a retry after part 2 went to the channel keeps the rest in the channel', async () => {
    f = await startFilling(t, [], { postRules: true });
    const form = await formWith(f, longFields());
    failNth(SUBMIT, 3);
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    expect(messagesIn(f, SUBMIT)).toHaveLength(2);
    await threadRule();

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toEqual(messagesIn(f, SUBMIT).map((message) => message.id));
    expect(row!.partMessageIds).toHaveLength(row!.render.parts.length);
    expect(threadRequests()).toEqual([]);
  });

  it('a retry after part 2 was deleted from the thread keeps the rest in the thread', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    const form = await formWith(f, [...longFields(), text(4, { type: 'long' })]);
    onNextPost(SUBMIT, (id) => failNth(id, 3));
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { ...longAnswers, q0000004: long('d') } });
    expect(contentOf(failed)).toContain("couldn't post");
    const [first] = messagesIn(f, SUBMIT);
    const [part2, part3] = messagesIn(f, first!.id);
    expect(messagesIn(f, first!.id)).toHaveLength(2);
    f.discord.messages.delete(part2!.id);

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    expect(messagesIn(f, SUBMIT)).toHaveLength(1);
    const inThread = messagesIn(f, first!.id);
    expect(inThread.map((message) => message.id)).toContain(part3!.id);
    expect(inThread).toHaveLength(2);
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toHaveLength(row!.render.parts.length);
    expect(row!.partMessageIds.slice(0, 3)).toEqual([first!.id, part2!.id, part3!.id]);
    expect(row!.restChannelId).toBe(first!.id);
  });

  it('a retry after part 1 was deleted posts the rest in the channel', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    const form = await formWith(f, longFields());
    onNextPost(SUBMIT, (id) => failOnce('POST', `/channels/${SUBMIT}/messages/${id}/threads`));
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    const [first] = messagesIn(f, SUBMIT);
    f.discord.messages.delete(first!.id);

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toEqual([first!.id, ...messagesIn(f, SUBMIT).map((message) => message.id)]);
    expect(row!.partMessageIds).toHaveLength(row!.render.parts.length);
    expect(f.discord.channels.has(first!.id)).toBe(false);
  });

  it('a one-part submission whose thread failed says only the thread is missing, and Discard confirms it', async () => {
    f = await startFilling(t, [], { postRules: true });
    await threadRule();
    const form = await formWith(f, [text(1)]);
    onNextPost(SUBMIT, (id) => failOnce('POST', `/channels/${SUBMIT}/messages/${id}/threads`));
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: { q0000001: 'Hello' } });
    expect(contentOf(failed)).toContain("Your submission to **Story contest** is posted, but I couldn't open its thread:");
    expect(contentOf(failed)).not.toContain('the rest');
    expect(contentOf(await open(f, await openerId(f, form)))).toContain("is posted, but its thread isn't open yet");

    const discarded = await clickIn(f, replyOf(failed), 'Discard');
    expect(contentOf(discarded)).toBe('Submitted to **Story contest**.\n**Question 1:** Hello');
    expect((await submissionRows(f))[0]).toMatchObject({ status: 'posted' });
    expect(await draftRows(f)).toEqual([]);
  });

  it('a retry ignores a thread opened by hand on part 1 after part 2 went to the channel', async () => {
    f = await startFilling(t, [], { postRules: true });
    const form = await formWith(f, longFields());
    failNth(SUBMIT, 3);
    const failed = await submitPage(f, await openModal(f, await openerId(f, form)), { fields: longAnswers });
    expect(contentOf(failed)).toContain("couldn't post");
    const [first] = messagesIn(f, SUBMIT);
    f.discord.addChannel(first!.id, { guildId: GUILD, type: ChannelType.PublicThread, parentId: SUBMIT });

    const retried = await clickIn(f, replyOf(failed), 'Try again');
    expect(contentOf(retried)).toContain('Submitted to **Story contest**.');
    const [row] = await submissionRows(f);
    expect(row!.partMessageIds).toEqual(messagesIn(f, SUBMIT).map((message) => message.id));
    expect(row!.partMessageIds).toHaveLength(row!.render.parts.length);
    expect(messagesIn(f, first!.id)).toEqual([]);
  });
});
