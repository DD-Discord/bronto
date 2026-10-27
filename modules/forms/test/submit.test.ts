import { fakeModal, type RecordedRequest } from '@bronto/core/testing';
import { Events, MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { GUILD, USER } from './harness.js';
import {
  clickIn,
  contentOf,
  draftRows,
  fileField,
  formWith,
  messagesIn,
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
import { shownModal, textOf, type Json } from './ui.js';

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
    expect(textOf(posted[1]!)).toContain(`(2/${posted.length})`);
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
    expect(contentOf(done)).toContain("1 file for a field that was removed wasn't posted.");
    expect(messagesIn(f, SUBMIT)[0]!.attachments).toEqual([]);
  });
});
