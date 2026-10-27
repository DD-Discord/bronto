import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, type Form } from '../src/db/schema.js';
import type { Field } from '../src/model.js';
import { prepareFormsBot, ready, formsDb, type FormsBot } from './harness.js';
import {
  addField,
  allComponents,
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
  type Json,
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

/** Opens a field's detail view through Edit field and the picker. */
async function openDetail(label: string) {
  const edit = await clickPreview(fb, discord, form.threadId, 'Edit field');
  const menu = payload(edit);
  const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [selectOf(menu).options.find((o: any) => o.label.includes(label)).value]);
  return payload(picked);
}

/** Opens the pop-up behind a button of the field's detail view. */
async function openPopup(label: string, button: string) {
  const detail = await openDetail(label);
  return shownModal(await click(fb, form.threadId, buttonId(detail, button)));
}

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
  it('adds a short field, lists it in the preview and ends on its detail view', async () => {
    const done = await addField(fb, discord, form, 'short', {
      fields: { label: 'Favorite color', description: 'One word' },
      checkboxes: { required: true },
    });
    const reply = payload(done);
    expect(reply.content).toContain('Favorite color');
    expect(reply.content).toContain('Added');
    buttonId(reply, 'Edit');
    buttonId(reply, 'Text limits');
    buttonId(reply, 'Remove field');
    const [field] = (await storedForm(t, form.id)).fields;
    expect(field).toEqual({ id: expect.stringMatching(/^[a-z0-9]{8}$/), type: 'short', label: 'Favorite color', description: 'One word', required: true });
    expect(previewText()).toContain('1. Favorite color · short text · required');
  });

  it('gives every type a pop-up of at most five inputs, with options only on choice types', async () => {
    const expected: Record<string, string[]> = {
      short: ['label', 'description', 'required', 'position'],
      long: ['label', 'description', 'required', 'position'],
      select: ['label', 'description', 'required', 'position', 'options'],
      radio: ['label', 'description', 'required', 'position', 'options'],
      checkboxes: ['label', 'description', 'required', 'position', 'options'],
      file: ['label', 'description', 'required', 'position'],
    };
    for (const [type, keys] of Object.entries(expected)) {
      const open = await clickPreview(fb, discord, form.threadId, 'Add field');
      const modal = shownModal(await choose(fb, form.threadId, selectOf(payload(open)).custom_id, [type]));
      const inputs = modalInputs(modal);
      expect(Object.keys(inputs)).toEqual(keys);
      expect(Object.values(inputs).map((input) => input.label)).toEqual(keys.map((key) => ({ label: 'Label', description: 'Description', required: 'Required', position: 'Position', options: 'Options' })[key]));
      expect(inputs.label).toMatchObject({ type: 4, style: 1, required: true, max_length: 45 });
      expect(inputs.description).toMatchObject({ type: 4, style: 1, max_length: 100 });
      expect(inputs.description!.required).toBeFalsy();
      expect(inputs.required!.type).toBe(23);
      expect(inputs.position).toMatchObject({ type: 4, style: 1 });
      if (keys.includes('options')) expect(inputs.options).toMatchObject({ type: 4, style: 2, required: true });
      expect(Object.keys(inputs).length).toBeLessThanOrEqual(5);
      expect(modal.title.length).toBeLessThanOrEqual(45);
      expect(modal.custom_id.length).toBeLessThanOrEqual(100);
      for (const input of Object.values(inputs)) {
        expect(input.label.length).toBeLessThanOrEqual(45);
        expect((input.description ?? '').length).toBeLessThanOrEqual(100);
        expect((input.placeholder ?? '').length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('keeps the longest custom ID of every editor component within 100 characters', async () => {
    await addField(fb, discord, form, 'file', { fields: { label: 'Cover' } });
    await addField(fb, discord, form, 'checkboxes', { fields: { label: 'Genres', options: 'A\nB' } });
    const { detail, modal } = await openFieldModal('Genres');
    expect(modal.custom_id.split(':')[1]).toBe('field-modal');
    const ids = [modal.custom_id, ...(detail.components as Json[]).flatMap((row) => allComponents([row])).map((c) => c.custom_id).filter(Boolean)];
    const limits = shownModal(await click(fb, form.threadId, buttonId(detail, 'Choice limits')));
    ids.push(limits.custom_id);
    const fileDetail = await openDetail('Cover');
    ids.push(shownModal(await click(fb, form.threadId, buttonId(fileDetail, 'File settings'))).custom_id);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
  });

  it('shows the extra button of each type and none for radio', async () => {
    const extras: Record<string, string | null> = { short: 'Text limits', long: 'Text limits', select: 'Choice limits', checkboxes: 'Choice limits', radio: null, file: 'File settings' };
    for (const [type, extra] of Object.entries(extras)) {
      const done = await addField(fb, discord, form, type, { fields: { label: `A ${type}`, options: 'One\nTwo' } });
      const labels = allComponents(payload(done).components).map((c) => c.label).filter(Boolean);
      expect(labels).toEqual(extra === null ? ['Edit', 'Remove field'] : ['Edit', extra, 'Remove field']);
    }
  });

  it('shows a summary of all settings in the detail view', async () => {
    await setFields([
      { id: 'aaaaaaaa', type: 'short', label: 'Name', required: true, placeholder: 'Jane', minLength: 2, maxLength: 30 },
      { id: 'bbbbbbbb', type: 'select', label: 'Pick', required: false, options: ['Red', 'Blue'], minChoices: 1, maxChoices: 2 },
      { id: 'cccccccc', type: 'file', label: 'Cover', description: 'A picture', required: false, maxFiles: 3, fileTypes: ['image', '.pdf'] },
    ]);
    const text = String((await openDetail('Name')).content);
    expect(text).toContain('Name');
    for (const part of ['Jane', '2', '30']) expect(text).toContain(part);
    const select = String((await openDetail('Pick')).content);
    for (const part of ['Red', 'Blue', 'Min choices', 'Max choices']) expect(select).toContain(part);
    const file = String((await openDetail('Cover')).content);
    for (const part of ['A picture', '3', 'image', '.pdf']) expect(file).toContain(part);
  });

  it('adds a radio field with options per line', async () => {
    await addField(fb, discord, form, 'radio', { fields: { label: 'Genre', options: 'Fantasy\n\nSci-fi\n Horror ' } });
    expect((await storedForm(t, form.id)).fields[0]).toMatchObject({ type: 'radio', options: ['Fantasy', 'Sci-fi', 'Horror'] });
  });

  it('adds a file field for one file of any type', async () => {
    await addField(fb, discord, form, 'file', { fields: { label: 'Cover' } });
    expect((await storedForm(t, form.id)).fields[0]).toMatchObject({ type: 'file', maxFiles: 1, fileTypes: [] });
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

  it('names the line of a duplicate option', async () => {
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

describe('saving a field', () => {
  it('replies with the detail view and keeps limits set in the extra pop-up', async () => {
    await setFields([{ id: 'aaaaaaaa', type: 'short', label: 'Name', required: false, placeholder: 'Jane', minLength: 2, maxLength: 30 }]);
    const { modal } = await openFieldModal('Name');
    const done = await submitModal(fb, form.threadId, modal, { fields: { label: 'Full name' } });
    expect(payload(done).content).toContain('Saved');
    buttonId(payload(done), 'Text limits');
    expect((await storedForm(t, form.id)).fields[0]).toMatchObject({ label: 'Full name', placeholder: 'Jane', minLength: 2, maxLength: 30 });
  });

  it('keeps choice limits that still fit the new options', async () => {
    await setFields([{ id: 'aaaaaaaa', type: 'select', label: 'Pick', required: false, options: ['A', 'B', 'C'], minChoices: 1, maxChoices: 2 }]);
    const { modal } = await openFieldModal('Pick');
    expect(modalInputs(modal).options!.value).toBe('A\nB\nC');
    await submitModal(fb, form.threadId, modal, { fields: { options: 'A\nB' } });
    expect((await storedForm(t, form.id)).fields[0]).toMatchObject({ options: ['A', 'B'], minChoices: 1, maxChoices: 2 });
    await submitModal(fb, form.threadId, modal, { fields: { options: 'A' } });
    const field = (await storedForm(t, form.id)).fields[0]!;
    expect(field).toMatchObject({ options: ['A'], minChoices: 1 });
    expect(field).not.toHaveProperty('maxChoices');
  });
});

describe('text limits', () => {
  const stored = async () => (await storedForm(t, form.id)).fields[0]!;
  beforeEach(async () => {
    await setFields([short(1)]);
  });

  it('opens with one input per value', async () => {
    const modal = await openPopup('Question 1', 'Text limits');
    const inputs = modalInputs(modal);
    expect(Object.keys(inputs)).toEqual(['placeholder', 'minLength', 'maxLength']);
    expect(Object.values(inputs).map((input) => input.label)).toEqual(['Placeholder', 'Min length', 'Max length']);
    for (const input of Object.values(inputs)) expect(input).toMatchObject({ type: 4, style: 1 });
    expect(inputs.placeholder!.max_length).toBe(100);
    expect(modal.title.length).toBeLessThanOrEqual(45);
  });

  it('saves each value and blank clears them', async () => {
    const modal = await openPopup('Question 1', 'Text limits');
    const done = await submitModal(fb, form.threadId, modal, { fields: { placeholder: 'Shown', minLength: '5', maxLength: '200' } });
    expect(payload(done).content).toContain('Question 1');
    expect(await stored()).toMatchObject({ placeholder: 'Shown', minLength: 5, maxLength: 200 });
    const again = await openPopup('Question 1', 'Text limits');
    expect(modalInputs(again).minLength!.value).toBe('5');
    await submitModal(fb, form.threadId, again, { fields: { placeholder: '', minLength: '', maxLength: '' } });
    expect(await stored()).toEqual(short(1));
  });

  it('refuses a number that is not whole, naming the input, and Try again reopens with what was typed', async () => {
    const modal = await openPopup('Question 1', 'Text limits');
    const done = await submitModal(fb, form.threadId, modal, { fields: { placeholder: 'Typed', minLength: '1.5', maxLength: '20' } });
    expect(payload(done).content).toContain('Min length');
    expect(await stored()).toEqual(short(1));
    const again = modalInputs(shownModal(await click(fb, form.threadId, buttonId(payload(done), 'Try again'))));
    expect([again.placeholder!.value, again.minLength!.value, again.maxLength!.value]).toEqual(['Typed', '1.5', '20']);
  });

  it('refuses a minimum above the maximum and a maximum above 4000', async () => {
    const modal = await openPopup('Question 1', 'Text limits');
    const swapped = await submitModal(fb, form.threadId, modal, { fields: { minLength: '9', maxLength: '3' } });
    expect(payload(swapped).content).toContain('Min length');
    const huge = await submitModal(fb, form.threadId, modal, { fields: { maxLength: '4001' } });
    expect(payload(huge).content).toContain('Max length');
    expect(await stored()).toEqual(short(1));
  });
});

describe('choice limits', () => {
  const stored = async () => (await storedForm(t, form.id)).fields[0]!;
  beforeEach(async () => {
    await setFields([{ id: 'aaaaaaaa', type: 'checkboxes', label: 'Pick', required: false, options: ['A', 'B', 'C'] }]);
  });

  it('opens with a min and a max input', async () => {
    const inputs = modalInputs(await openPopup('Pick', 'Choice limits'));
    expect(Object.keys(inputs)).toEqual(['minChoices', 'maxChoices']);
    expect(Object.values(inputs).map((input) => input.label)).toEqual(['Min choices', 'Max choices']);
  });

  it('saves both values and blank goes back to the default', async () => {
    const modal = await openPopup('Pick', 'Choice limits');
    await submitModal(fb, form.threadId, modal, { fields: { minChoices: '1', maxChoices: '2' } });
    expect(await stored()).toMatchObject({ minChoices: 1, maxChoices: 2 });
    await submitModal(fb, form.threadId, modal, { fields: { minChoices: '', maxChoices: '' } });
    const field = await stored();
    expect(field).not.toHaveProperty('minChoices');
    expect(field).not.toHaveProperty('maxChoices');
  });

  it('refuses invalid limits with the reason and Try again keeps the typed values', async () => {
    const modal = await openPopup('Pick', 'Choice limits');
    const words = await submitModal(fb, form.threadId, modal, { fields: { minChoices: 'two' } });
    expect(payload(words).content).toContain('Min choices');
    const swapped = await submitModal(fb, form.threadId, modal, { fields: { minChoices: '3', maxChoices: '2' } });
    expect(payload(swapped).content).toContain('Min choices');
    const tooMany = await submitModal(fb, form.threadId, modal, { fields: { minChoices: '', maxChoices: '4' } });
    expect(payload(tooMany).content).toContain('Max choices');
    const again = modalInputs(shownModal(await click(fb, form.threadId, buttonId(payload(tooMany), 'Try again'))));
    expect(again.maxChoices!.value).toBe('4');
    expect(await stored()).toEqual({ id: 'aaaaaaaa', type: 'checkboxes', label: 'Pick', required: false, options: ['A', 'B', 'C'] });
  });
});

describe('file settings', () => {
  const stored = async () => (await storedForm(t, form.id)).fields[0]!;
  beforeEach(async () => {
    await setFields([{ id: 'aaaaaaaa', type: 'file', label: 'Cover', required: false, maxFiles: 1, fileTypes: ['video'] }]);
  });

  it('opens with a number input and a types input', async () => {
    const inputs = modalInputs(await openPopup('Cover', 'File settings'));
    expect(Object.keys(inputs)).toEqual(['maxFiles', 'fileTypes']);
    expect(Object.values(inputs).map((input) => input.label)).toEqual(['Max files', 'File types']);
    expect(inputs.maxFiles).toMatchObject({ type: 4, style: 1, value: '1' });
    expect(inputs.fileTypes).toMatchObject({ type: 4, style: 1, value: 'video', placeholder: 'image, video, .txt, .md' });
  });

  it('saves the count and the types', async () => {
    const modal = await openPopup('Cover', 'File settings');
    await submitModal(fb, form.threadId, modal, { fields: { maxFiles: '3', fileTypes: 'Image, .md' } });
    expect(await stored()).toMatchObject({ maxFiles: 3, fileTypes: ['image', '.md'] });
  });

  it('treats blank types as any type', async () => {
    const modal = await openPopup('Cover', 'File settings');
    await submitModal(fb, form.threadId, modal, { fields: { fileTypes: '  ' } });
    expect(await stored()).toMatchObject({ maxFiles: 1, fileTypes: [] });
  });

  it('refuses 11 files and Try again reopens with the typed values', async () => {
    const modal = await openPopup('Cover', 'File settings');
    const done = await submitModal(fb, form.threadId, modal, { fields: { maxFiles: '11', fileTypes: 'image' } });
    expect(payload(done).content).toContain('Max files');
    expect(await stored()).toMatchObject({ maxFiles: 1, fileTypes: ['video'] });
    const again = modalInputs(shownModal(await click(fb, form.threadId, buttonId(payload(done), 'Try again'))));
    expect([again.maxFiles!.value, again.fileTypes!.value]).toEqual(['11', 'image']);
  });

  it('refuses a count that is not a number and a bad type', async () => {
    const modal = await openPopup('Cover', 'File settings');
    expect(payload(await submitModal(fb, form.threadId, modal, { fields: { maxFiles: 'many' } })).content).toContain('Max files');
    const bad = await submitModal(fb, form.threadId, modal, { fields: { fileTypes: 'image, notatype' } });
    expect(payload(bad).content).toContain('File types');
    expect(payload(bad).content).toContain('notatype');
  });
});
