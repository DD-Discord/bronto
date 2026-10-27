import { MessageFlags } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { drafts, submissions } from '../src/db/schema.js';
import { DRAFT_TTL_MS, sweepDrafts } from '../src/drafts.js';
import { forgetForm } from '../src/lifecycle.js';
import { formsDb, inHandler, USER } from './harness.js';
import {
  clickIn,
  contentOf,
  draftRows,
  fileField,
  formWith,
  labelsOf,
  messagesIn,
  open,
  openerId,
  openModal,
  replyOf,
  ROLE,
  startFilling,
  submissionRows,
  SUBMIT,
  submitPage,
  TEXT,
  text,
  upload,
  type Filling,
} from './filling.js';
import { buttonId, choose, click, clickPreview, modalInputs, selectOf, shownModal, submitModal, textOf, type Json } from './ui.js';

let t: TestDatabase;
let f: Filling;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  vi.useRealTimers();
  await f?.fb.bot.stop();
  await t.drop();
});

const seven = () => [1, 2, 3, 4, 5, 6, 7].map((n) => text(n));

/** The draft-file messages: bot messages with attachments outside the channels the tests use. */
const draftFileMessages = () => [...f.discord.messages.values()].filter((message) => message.attachments.length > 0 && message.channel_id !== TEXT);

describe('opening a form', () => {
  it.each([
    ['closed', { active: false, fields: [] }, 'This form is currently closed.'],
    ['without fields', { fields: [] }, 'This form has no fields yet.'],
    ['for other roles', { allowedRoleIds: [ROLE] }, "You can't fill in this form."],
  ])('refuses a form %s', async (_name, change, message) => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)], change);
    const fake = await open(f, await openerId(f, form));
    expect(contentOf(fake)).toBe(message);
  });

  it('opens for a member with an allowed role', async () => {
    f = await startFilling(t, [ROLE]);
    const form = await formWith(f, [text(1)], { allowedRoleIds: [ROLE] });
    const fake = await open(f, await openerId(f, form));
    expect(labelsOf(shownModal(fake))).toEqual(['Question 1']);
  });

  it('refuses a member who already submitted a once-per-member form', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1)]);
    await formsDb(t).run(async (tx) => {
      await tx.insert(submissions).values({ formId: form.id, userId: USER, answers: {}, channelId: SUBMIT, status: 'posted', once: true });
    });
    expect(contentOf(await open(f, await openerId(f, form)))).toBe('You already submitted this form.');
  });

  it('shows five fields per page and continues with the next page', async () => {
    f = await startFilling(t);
    const form = await formWith(f, seven());
    const first = await openModal(f, await openerId(f, form));
    expect(first.title).toBe('Story contest (1/2)');
    expect(labelsOf(first)).toEqual(['Question 1', 'Question 2', 'Question 3', 'Question 4', 'Question 5']);
    const saved = await submitPage(f, first, { fields: { q0000001: 'One' } });
    expect(contentOf(saved)).toBe('Page 1 of 2 saved.');
    const second = shownModal(await clickIn(f, replyOf(saved), 'Continue (2/2)'));
    expect(second.title).toBe('Story contest (2/2)');
    expect(labelsOf(second)).toEqual(['Question 6', 'Question 7']);
  });

  it('builds the input of each field type', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [
      text(1, { type: 'long', required: true, minLength: 10, maxLength: 500, placeholder: 'Your story' }),
      { id: 's0000001', type: 'select', label: 'Genre', required: true, options: ['Fantasy', 'Mystery'] },
      { id: 'r0000001', type: 'radio', label: 'Length', required: false, options: ['Short', 'Long'] },
      { id: 'c0000001', type: 'checkboxes', label: 'Agree', required: false, options: ['I wrote it'] },
      fileField(1, { required: true, maxFiles: 2, fileTypes: ['image', '.pdf'] }),
    ]);
    const inputs = modalInputs(await openModal(f, await openerId(f, form)));
    expect(inputs.q0000001).toMatchObject({ type: 4, style: 2, required: true, min_length: 10, max_length: 500, placeholder: 'Your story' });
    expect(inputs.s0000001).toMatchObject({ type: 3, required: true, min_values: 1, max_values: 1 });
    expect(inputs.s0000001!.options.map((o: Json) => o.label)).toEqual(['Fantasy', 'Mystery']);
    expect(inputs.r0000001).toMatchObject({ type: 21, required: false });
    expect(inputs.c0000001).toMatchObject({ type: 23 });
    expect(inputs.f0000001).toMatchObject({ type: 19, min_values: 1, max_values: 2, file_types: ['image', '.pdf'] });
  });

  it('keeps the page suffix whole when the title is too long', async () => {
    f = await startFilling(t);
    const form = await formWith(f, seven(), { name: 'x'.repeat(45) });
    const modal = await openModal(f, await openerId(f, form));
    expect(modal.title).toHaveLength(45);
    expect(modal.title.endsWith('… (1/2)')).toBe(true);
  });

  it('resumes a draft', async () => {
    f = await startFilling(t);
    const form = await formWith(f, seven());
    const opener = await openerId(f, form);
    await submitPage(f, await openModal(f, opener), { fields: { q0000001: 'One' } });
    const again = await openModal(f, opener);
    expect(again.title).toBe('Story contest (2/2)');
    const [draft] = await draftRows(f);
    expect(draft!.answers.q0000001).toEqual({ text: 'One' });
  });

  it('expired draft starts over and deletes its files', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T12:00:00Z') });
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1), ...seven().slice(0, 6)]);
    const opener = await openerId(f, form);
    await submitPage(f, await openModal(f, opener), { uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    expect(draftFileMessages()).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 23 * 3600_000));
    expect((await openModal(f, opener)).title).toBe('Story contest (2/2)');
    vi.setSystemTime(new Date(Date.now() + 2 * 3600_000));
    expect((await openModal(f, opener)).title).toBe('Story contest (1/2)');
    expect(await draftRows(f)).toEqual([]);
    expect(draftFileMessages()).toEqual([]);
  });

  it('refuses a file over the upload limit and keeps the typed answers', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1), fileField(1)]);
    const modal = await openModal(f, await openerId(f, form));
    const refused = await submitPage(f, modal, { fields: { q0000001: 'My story' }, uploads: { f0000001: [upload(f, 'huge.png', 3 * 1024 * 1024)] } }, { attachmentSizeLimit: 2 * 1024 * 1024 + 1000 });
    expect(contentOf(refused)).toContain('huge.png is larger than 2 MB, the most this server accepts.');
    expect(await submissionRows(f)).toEqual([]);
    expect(draftFileMessages()).toEqual([]);
    const retried = shownModal(await clickIn(f, replyOf(refused), 'Try again'));
    expect(modalInputs(retried).q0000001!.value).toBe('My story');
  });

  it('refuses a file type the field does not accept', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1, { fileTypes: ['.pdf'] })]);
    const refused = await submitPage(f, await openModal(f, await openerId(f, form)), { uploads: { f0000001: [upload(f, 'story.exe', 'x')] } });
    expect(contentOf(refused)).toContain("story.exe isn't a file type Files 1 accepts");
  });

  it('Cancel deletes the draft and its file message', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1), ...seven()]);
    const saved = await submitPage(f, await openModal(f, await openerId(f, form)), { uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    expect(await draftRows(f)).toHaveLength(1);
    expect(draftFileMessages()).toHaveLength(1);
    const cancelled = await clickIn(f, replyOf(saved), 'Cancel');
    expect(contentOf(cancelled)).toContain('deleted');
    expect(await draftRows(f)).toEqual([]);
    expect(draftFileMessages()).toEqual([]);
  });

  it('stores uploads in a locked drafts post of the forum', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [fileField(1), ...seven()]);
    await submitPage(f, await openModal(f, await openerId(f, form)), { uploads: { f0000001: [upload(f, 'a.png', 'a'), upload(f, 'b.png', 'b')] } });
    const [message] = draftFileMessages();
    expect(message!.attachments).toHaveLength(2);
    const thread = f.discord.channels.get(message!.channel_id) as Json;
    expect(thread).toMatchObject({ name: 'drafts', thread_metadata: { locked: true } });
    const [draft] = await draftRows(f);
    expect(draft!.files.map((file) => file.name)).toEqual(['a.png', 'b.png']);
    expect(draft!.answers.f0000001).toEqual({ files: draft!.files.map((file) => file.key) });
  });
});

describe('cleaning up draft files', () => {
  async function draftWithFile(fields = [fileField(1), ...seven()]) {
    const form = await formWith(f, fields);
    await submitPage(f, await openModal(f, await openerId(f, form)), { uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    expect(draftFileMessages()).toHaveLength(1);
    return form;
  }

  it('the sweep deletes expired drafts and their files and keeps fresh ones', async () => {
    f = await startFilling(t);
    const form = await draftWithFile();
    await inHandler(f.fb, (ctx) => sweepDrafts(ctx));
    expect(await draftRows(f)).toHaveLength(1);
    await formsDb(t).run(async (tx) => {
      await tx.update(drafts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(drafts.formId, form.id));
    });
    await inHandler(f.fb, (ctx) => sweepDrafts(ctx));
    expect(await draftRows(f)).toEqual([]);
    expect(draftFileMessages()).toEqual([]);
  });

  it('deleting a form deletes the files of its drafts', async () => {
    f = await startFilling(t);
    const form = await draftWithFile();
    await inHandler(f.fb, (ctx) => forgetForm(ctx, form));
    expect(draftFileMessages()).toEqual([]);
  });

  it('removing a file field deletes its draft files', async () => {
    f = await startFilling(t);
    const form = await draftWithFile();
    const pick = await clickPreview(f.fb, f.discord, form.threadId, 'Edit field');
    const picked = await choose(f.fb, form.threadId, selectOf(replyOf(pick)).custom_id, ['f0000001']);
    await click(f.fb, form.threadId, buttonId(replyOf(picked), 'Remove field'));
    expect(draftFileMessages()).toEqual([]);
    const [draft] = await draftRows(f);
    expect(draft!.files).toEqual([]);
  });

  it('has a lifetime of a day', () => {
    expect(DRAFT_TTL_MS).toBe(86_400_000);
  });
});

describe('Try it', () => {
  it('replies with a preview and creates no submission row and no channel message', async () => {
    f = await startFilling(t);
    const form = await formWith(f, [text(1), fileField(1)], { active: false });
    const modal = shownModal(await clickPreview(f.fb, f.discord, form.threadId, 'Try it'));
    expect(modal.title).toBe('Story contest');
    const done = await submitModal(f.fb, form.threadId, modal, { fields: { q0000001: 'Trial answer' }, uploads: { f0000001: [upload(f, 'cover.png', 'png bytes')] } });
    const reply = replyOf(done);
    expect(reply.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(reply.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(textOf(reply)).toContain('Trial answer');
    expect(textOf(reply)).toContain('cover.png');
    expect(await submissionRows(f)).toEqual([]);
    expect(messagesIn(f, SUBMIT)).toEqual([]);
    expect(await draftRows(f)).toEqual([]);
    expect(draftFileMessages()).toEqual([]);
  });
});
