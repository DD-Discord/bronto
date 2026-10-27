import { FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, type Form } from '../src/db/schema.js';
import type { Field } from '../src/model.js';
import { GUILD, USER, prepareFormsBot, ready, formsDb, type FormsBot } from './harness.js';
import { buttonId, choose, click, clickPreview, makeForm, payload, selectOf, shownModal, storeForum, storedForm, submitModal } from './ui.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let fb: FormsBot;
let form: Form;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  fb = await prepareFormsBot(t, discord);
  await storeForum(t);
  await ready(fb);
  form = await makeForm(fb);
});

afterEach(async () => {
  await fb.bot.stop();
  await t.drop();
});

/** The ways an interaction can answer by editing the message its component sits on. */
const EDITS = ['update', 'editReply'];

/** Asserts the interaction edited its message and posted nothing new. */
function expectEdit(fake: FakeInteraction): void {
  const kinds = fake.responses.map((response) => response.kind);
  expect(kinds.some((kind) => EDITS.includes(kind)), `responses: ${kinds.join(', ')}`).toBe(true);
  expect(kinds).not.toContain('reply');
  expect(kinds).not.toContain('followUp');
}

async function setFields(fields: Field[]): Promise<void> {
  await formsDb(t).run(async (tx) => {
    await tx.update(forms).set({ fields });
  });
}

const short = (n: number): Field => ({ id: `field00${n}`.slice(-8), type: 'short', label: `Question ${n}`, required: false });

describe('one private message per editing flow', () => {
  it('adds a field and sets its text limits on the same message', async () => {
    const open = await clickPreview(fb, discord, form.threadId, 'Add field');
    expect(open.responses.map((r) => r.kind)).toEqual(['reply']);
    const picked = await choose(fb, form.threadId, selectOf(payload(open)).custom_id, ['short']);
    expect(picked.responses.map((r) => r.kind)).toEqual(['showModal']);
    const added = await submitModal(fb, form.threadId, shownModal(picked), { fields: { label: 'Name' } });
    expectEdit(added);
    expect(payload(added).content).toContain('Added');
    const limits = await click(fb, form.threadId, buttonId(payload(added), 'Text limits'));
    const saved = await submitModal(fb, form.threadId, shownModal(limits), { fields: { minLength: '2' } });
    expectEdit(saved);
    expect(payload(saved).content).toContain('Saved.');
    expect((await storedForm(t, form.id)).fields[0]).toMatchObject({ minLength: 2 });
  });

  it('updates the detail view after Edit', async () => {
    await setFields([short(1)]);
    const edit = await clickPreview(fb, discord, form.threadId, 'Edit field');
    const menu = payload(edit);
    const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options[0].value]);
    const detail = await click(fb, form.threadId, buttonId(payload(picked), 'Edit'));
    const saved = await submitModal(fb, form.threadId, shownModal(detail), { fields: { label: 'Renamed' } });
    expectEdit(saved);
    expect(payload(saved).content).toContain('Renamed');
  });

  it('replaces the refusal with the detail view after Try again', async () => {
    await setFields([short(1)]);
    const edit = await clickPreview(fb, discord, form.threadId, 'Edit field');
    const menu = payload(edit);
    const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options[0].value]);
    const popup = shownModal(await click(fb, form.threadId, buttonId(payload(picked), 'Text limits')));
    const refused = await submitModal(fb, form.threadId, popup, { fields: { minLength: 'x' } });
    expectEdit(refused);
    expect(payload(refused).content).toContain('Min length');
    const again = shownModal(await click(fb, form.threadId, buttonId(payload(refused), 'Try again')));
    const saved = await submitModal(fb, form.threadId, again, { fields: { minLength: '3' } });
    expectEdit(saved);
    expect(payload(saved).content).toContain('Saved.');
    buttonId(payload(saved), 'Remove field');
  });

  it('shows the detail view in place of the Edit field picker', async () => {
    await setFields([short(1)]);
    const menu = payload(await clickPreview(fb, discord, form.threadId, 'Edit field'));
    const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options[0].value]);
    expectEdit(picked);
    buttonId(payload(picked), 'Remove field');
  });

  it('shows the result of Remove field in place', async () => {
    await setFields([short(1)]);
    const menu = payload(await clickPreview(fb, discord, form.threadId, 'Edit field'));
    const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options[0].value]);
    const removed = await click(fb, form.threadId, buttonId(payload(picked), 'Remove field'));
    expectEdit(removed);
    expect(payload(removed).content).toContain('removed');
  });

  it('keeps the settings Try again on the refusal message', async () => {
    discord.addMember(GUILD, USER);
    const open = await clickPreview(fb, discord, form.threadId, 'Settings');
    const refused = await submitModal(fb, form.threadId, shownModal(open), { fields: { name: '   ' }, selections: { channel: [], roles: [], options: [] }, mentionables: { pings: {} } });
    expect(refused.responses.map((r) => r.kind)).toEqual(['reply']);
    const again = shownModal(await click(fb, form.threadId, buttonId(payload(refused), 'Try again')));
    
    const saved = await submitModal(fb, form.threadId, again, { fields: { name: 'Renamed form' }, selections: { channel: [], roles: [], options: [] }, mentionables: { pings: {} } });
    expectEdit(saved);
    expect(payload(saved).content).toContain('Settings saved');
  });

  it('starts the detail view type line without a separator', async () => {
    await setFields([{ ...short(1), type: 'long' }]);
    const menu = payload(await clickPreview(fb, discord, form.threadId, 'Edit field'));
    const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options[0].value]);
    const lines = String(payload(picked).content).split('\n');
    expect(lines.slice(0, 2)).toEqual(['**1. Question 1**', 'Long text · optional']);
  });
});
