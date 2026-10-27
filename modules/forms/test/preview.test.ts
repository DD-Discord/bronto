import { FakeDiscordHttp } from '@bronto/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import type { Form } from '../src/db/schema.js';
import type { Field } from '../src/model.js';
import { previewMessage } from '../src/preview.js';
import { inHandler, prepareFormsBot, ready, type FormsBot } from './harness.js';

let t: TestDatabase;
let fb: FormsBot;

beforeEach(async () => {
  t = await createTestDatabase();
  fb = await prepareFormsBot(t, new FakeDiscordHttp());
  await ready(fb);
});

afterEach(async () => {
  await fb.bot.stop();
  await t.drop();
});

const form = (fields: Field[]): Form =>
  ({
    id: '00000000-0000-0000-0000-000000000001',
    guildId: 'g',
    threadId: '100000000000000555',
    previewMessageId: '100000000000000555',
    name: 'Story contest',
    active: true,
    channelId: '100000000000000777',
    pingUserIds: [],
    pingRoleIds: ['100000000000000888'],
    allowedRoleIds: [],
    oncePerMember: false,
    fields,
    removedFieldIds: [],
  }) as unknown as Form;

const field = (n: number): Field => ({
  id: n.toString(36).padStart(8, '0'),
  type: 'short',
  label: `Question ${n} ${'x'.repeat(30)}`,
  required: n % 2 === 0,
});

const textOf = (message: ReturnType<typeof previewMessage>) => JSON.stringify((message.components![0] as { toJSON(): unknown }).toJSON());

describe('previewMessage', () => {
  it('summarizes settings and numbers the fields by page', async () => {
    const message = await inHandler(fb, async (ctx) => previewMessage(ctx, form([field(1), field(2), field(3), field(4), field(5), field(6)])));
    const text = textOf(message);
    expect(text).toContain('Active');
    expect(text).toContain('many per member');
    expect(text).toContain('<#100000000000000777>');
    expect(text).toContain('<@&100000000000000888>');
    expect(text).toContain('**Page 2**');
    expect(text).toContain('6. Question 6');
    expect(text).toContain('short text · optional');
  });

  it('lists the overflow of a long form as "… and N more"', async () => {
    const fields = Array.from({ length: 200 }, (_, i) => ({ ...field(i), label: 'y'.repeat(45) }));
    const message = await inHandler(fb, async (ctx) => previewMessage(ctx, form(fields)));
    const json = (message.components![0] as { toJSON(): { components: { content?: string }[] } }).toJSON();
    const total = json.components.reduce((sum, c) => sum + (c.content?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(4000);
    const shown = (json.components[2]!.content!.match(/^\d+\./gm) ?? []).length;
    expect(json.components[2]!.content).toContain(`… and ${200 - shown} more`);
  });
});
