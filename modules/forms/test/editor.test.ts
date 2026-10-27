import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, type Form } from '../src/db/schema.js';
import type { Field } from '../src/model.js';
import { prepareFormsBot, ready, formsDb, type FormsBot } from './harness.js';
import {
  addField,
  buttonId,
  choose,
  click,
  clickPreview,
  modalInputs,
  payload,
  selectOf,
  shownModal,
  storeForum,
  storedForm,
  submitModal,
  textOf,
  makeForm,
  toJson,
} from './ui.js';

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

const previewText = () => textOf(toJson(discord.messages.get(form.threadId)));

async function setFields(fields: Field[], removed: string[] = []): Promise<void> {
  await formsDb(t).run(async (tx) => {
    await tx.update(forms).set({ fields, removedFieldIds: removed });
  });
}

const short = (n: number): Field => ({ id: `field00${n}`.slice(-8), type: 'short', label: `Question ${n}`, required: false });

/** Opens the field's modal through Edit field, the select and the detail view's Edit button. */
async function openFieldModal(label: string) {
  const edit = await clickPreview(fb, discord, form.threadId, 'Edit field');
  const menu = payload(edit);
  const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options.find((o: any) => o.label.includes(label)).value]);
  const detail = payload(picked);
  const opened = await click(fb, form.threadId, buttonId(detail, 'Edit'));
  return { detail, modal: shownModal(opened) };
}

describe('add field', () => {
  it('adds a short field and lists it in the preview', async () => {
    const done = await addField(fb, discord, form, 'short', {
      fields: { label: 'Favorite color', description: 'One word', options: '2-30\nBlue' },
      checkboxes: { required: true },
    });
    expect(payload(done).content).toContain('Favorite color');
    const [field] = (await storedForm(t, form.id)).fields;
    expect(field).toMatchObject({ type: 'short', label: 'Favorite color', description: 'One word', required: true, minLength: 2, maxLength: 30, placeholder: 'Blue' });
    expect(field!.id).toMatch(/^[a-z0-9]{8}$/);
    expect(previewText()).toContain('1. Favorite color · short text · required');
  });

  it('builds a modal of five labelled inputs for every type', async () => {
    for (const type of ['short', 'long', 'select', 'radio', 'checkboxes', 'file']) {
      const open = await clickPreview(fb, discord, form.threadId, 'Add field');
      const modal = shownModal(await choose(fb, form.threadId, selectOf(payload(open)).custom_id, [type]));
      expect(Object.keys(modalInputs(modal))).toEqual(['label', 'description', 'options', 'required', 'position']);
      expect(modal.title.length).toBeLessThanOrEqual(45);
      expect(modal.custom_id.length).toBeLessThanOrEqual(100);
      for (const input of Object.values(modalInputs(modal))) {
        expect(input.label.length).toBeLessThanOrEqual(45);
        expect((input.description ?? '').length).toBeLessThanOrEqual(100);
        expect((input.placeholder ?? '').length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('parses options per type', async () => {
    await addField(fb, discord, form, 'radio', { fields: { label: 'Genre', options: 'Fantasy\n\nSci-fi\n Horror ' } });
    await addField(fb, discord, form, 'file', { fields: { label: 'Cover', options: '3\nimage, .pdf' } });
    const fields = (await storedForm(t, form.id)).fields;
    expect(fields[0]).toMatchObject({ type: 'radio', options: ['Fantasy', 'Sci-fi', 'Horror'] });
    expect(fields[1]).toMatchObject({ type: 'file', maxFiles: 3, fileTypes: ['image', '.pdf'] });
  });

  it('refuses 26 select options and Try again reopens with the typed text', async () => {
    const options = Array.from({ length: 26 }, (_, i) => `Option ${i + 1}`).join('\n');
    const done = await addField(fb, discord, form, 'select', { fields: { label: 'Pick one', options } });
    const reply = payload(done);
    expect(reply.content).toMatch(/25/);
    expect((await storedForm(t, form.id)).fields).toEqual([]);
    const again = await click(fb, form.threadId, buttonId(reply, 'Try again'));
    const inputs = modalInputs(shownModal(again));
    expect(inputs.label!.value).toBe('Pick one');
    expect(inputs.options!.value).toBe(options);
  });

  it('names the line of a bad option input', async () => {
    const done = await addField(fb, discord, form, 'short', { fields: { label: 'Name', options: '9-x' } });
    expect(payload(done).content).toContain('line 1');
    const file = await addField(fb, discord, form, 'file', { fields: { label: 'Doc', options: '2\nnotatype' } });
    expect(payload(file).content).toContain('line 2');
    const dup = await addField(fb, discord, form, 'radio', { fields: { label: 'Dup', options: 'A\nB\nA' } });
    expect(payload(dup).content).toContain('line 3');
  });

  it('refuses a position outside the form', async () => {
    const done = await addField(fb, discord, form, 'short', { fields: { label: 'Name', position: '4' } });
    expect(payload(done).content).toContain('Position');
    expect((await storedForm(t, form.id)).fields).toEqual([]);
  });

  it('inserts a new field at the given position', async () => {
    await setFields([short(1), short(2)]);
    await addField(fb, discord, form, 'short', { fields: { label: 'First', position: '1' } });
    expect((await storedForm(t, form.id)).fields.map((f) => f.label)).toEqual(['First', 'Question 1', 'Question 2']);
  });

  it('never reuses the ID of a removed field', async () => {
    await setFields([], ['aaaaaaaa']);
    await addField(fb, discord, form, 'short', { fields: { label: 'New' } });
    const row = await storedForm(t, form.id);
    expect(row.fields[0]!.id).not.toBe('aaaaaaaa');
    expect(row.removedFieldIds).toEqual(['aaaaaaaa']);
  });
});

describe('edit field', () => {
  it('edits the label and keeps the ID', async () => {
    await setFields([short(1), short(2)]);
    const { modal } = await openFieldModal('Question 2');
    expect(modalInputs(modal).label!.value).toBe('Question 2');
    await submitModal(fb, form.threadId, modal, { fields: { label: 'Renamed' } });
    const fields = (await storedForm(t, form.id)).fields;
    expect(fields.map((f) => f.label)).toEqual(['Question 1', 'Renamed']);
    expect(fields[1]!.id).toBe(short(2).id);
    expect(previewText()).toContain('2. Renamed');
  });

  it('moves a field to position 1', async () => {
    await setFields([short(1), short(2), short(3)]);
    const { modal } = await openFieldModal('Question 3');
    await submitModal(fb, form.threadId, modal, { fields: { position: '1' } });
    expect((await storedForm(t, form.id)).fields.map((f) => f.label)).toEqual(['Question 3', 'Question 1', 'Question 2']);
  });

  it('keeps the position when it is blank', async () => {
    await setFields([short(1), short(2)]);
    const { modal } = await openFieldModal('Question 1');
    await submitModal(fb, form.threadId, modal, { fields: { label: 'Same place', position: '' } });
    expect((await storedForm(t, form.id)).fields.map((f) => f.label)).toEqual(['Same place', 'Question 2']);
  });

  it('removes a field and records its ID', async () => {
    await setFields([short(1), short(2)]);
    const { detail } = await openFieldModal('Question 1');
    const done = await click(fb, form.threadId, buttonId(detail, 'Remove field'));
    expect(payload(done).content ?? textOf(payload(done))).toContain('removed');
    const row = await storedForm(t, form.id);
    expect(row.fields.map((f) => f.label)).toEqual(['Question 2']);
    expect(row.removedFieldIds).toEqual([short(1).id]);
    expect(previewText()).not.toContain('Question 1');
  });

  it('pages the select with 25 fields at a time', async () => {
    await setFields(Array.from({ length: 30 }, (_, i) => ({ ...short(i), id: `f${String(i).padStart(7, '0')}`, label: `Q${i + 1}` })));
    const edit = await clickPreview(fb, discord, form.threadId, 'Edit field');
    const menu = payload(edit);
    expect(selectOf(menu).options).toHaveLength(25);
    const next = await click(fb, form.threadId, buttonId(menu, '›'));
    const second = payload(next);
    expect(selectOf(second).options.map((o: any) => o.label)).toEqual(['26. Q26', '27. Q27', '28. Q28', '29. Q29', '30. Q30']);
    expect(second.components).toBeDefined();
  });

  it('refuses a field that was removed in the meantime', async () => {
    await setFields([short(1)]);
    const { modal } = await openFieldModal('Question 1');
    await setFields([]);
    const done = await submitModal(fb, form.threadId, modal, { fields: { label: 'Late' } });
    expect(payload(done).content).toContain('no longer');
  });
});
