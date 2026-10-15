import { ApplicationCommandOptionType, type Client, type EmbedBuilder } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineEntity } from '../src/crud/entity.js';
import { crudSubcommands } from '../src/crud/subcommands.js';
import { upsertGuild } from '../src/db/guilds.js';
import { createScopedDb } from '../src/db/scoped.js';
import { commandToJson, defineCommand, defineSubcommand } from '../src/interactions/commands.js';
import { UserError } from '../src/interactions/errors.js';
import { opt } from '../src/interactions/options.js';
import { InteractionRouter } from '../src/interactions/router.js';
import { createModuleRuntimes } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { fakeCommand } from '../src/testing/interactions.js';
import { captureLog } from '../src/testing/log.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const calls: string[] = [];
let generated = 0;

const widgets = defineEntity({
  table: widgetItems,
  key: 'id',
  displayName: { singular: 'Widget', plural: 'Widgets' },
  formatShort: (widget) => `${widget.label} (${widget.count})`,
});

const widgetCommand = defineCommand({
  name: 'widget',
  description: 'Widgets',
  subcommands: crudSubcommands(widgets, {
    key: { name: 'id', option: opt.string({ description: 'Widget ID' }), toKey: (value) => value, fallback: (ctx) => ctx.channelId },
    fields: {
      label: { option: opt.string({ description: 'Label' }), column: 'label' },
      count: { option: opt.integer({ description: 'Count' }), column: 'count', default: 1 },
    },
    hooks: {
      prepare: (_ctx, values, existing) => {
        calls.push(`prepare:${values.id}:${existing?.label ?? 'new'}:${values.count}`);
        if (values.label === 'refuse') throw new UserError('Prepare refused.');
        if (values.label === 'rekey') return { id: 'stolen', label: 'rekeyed' };
        return values.label === 'shout' ? { label: 'SHOUT' } : undefined;
      },
      validate: (record) => (record.count !== undefined && record.count < 0 ? ['Count must not be negative.'] : []),
      afterWrite: (_ctx, record, action) => {
        calls.push(`${action}:${record.id}`);
      },
      beforeDelete: async (ctx, record) => {
        calls.push(`delete:${record.id}`);
        // Simulates another delete winning the race.
        if (record.label === 'vanish') {
          await ctx.db.run(async (tx) => {
            await tx.delete(widgetItems).where(eq(widgetItems.id, record.id));
          });
        }
      },
    },
  }),
});

const gadgetCommand = defineCommand({
  name: 'gadget',
  description: 'Gadgets',
  subcommands: crudSubcommands(widgets, {
    key: { name: 'gadget', option: opt.string({ description: 'Gadget' }), toKey: (value) => value, generate: () => `gen-${++generated}` },
    fields: { label: { option: opt.string({ description: 'Label' }), column: 'label' } },
    omit: ['edit'],
    override: { list: defineSubcommand({ description: 'Custom list', execute: (ctx) => ctx.reply('custom') }) },
    ephemeral: false,
  }),
});

let t: TestDatabase;
let router: InteractionRouter;

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await upsertGuild(t.database.admin, 'g1');
  await upsertGuild(t.database.admin, 'g2');
  const { log } = captureLog();
  const definition = widgetsModule({ commands: [widgetCommand, gadgetCommand] });
  const runtimes = createModuleRuntimes([{ packageName: '@test/widgets', definition, config: {} }], {
    client: {} as Client,
    database: t.database,
    log,
  });
  const enablement = new ModuleEnablement(t.database.admin);
  const dispatcher = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
  router = new InteractionRouter({
    sources: [{ runtime: runtimes[0]!, commands: [widgetCommand, gadgetCommand], components: [] }],
    dispatcher,
    enablement,
    guildGate: async () => true,
    log,
  });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  calls.length = 0;
  await t.database.admin.delete(widgetItems);
});

interface Payload {
  content?: string;
  embeds?: EmbedBuilder[];
  flags?: number;
}

async function say(command: string, subcommand: string, options: Record<string, unknown> = {}, channelId = 'c1') {
  const fake = fakeCommand({ command, subcommand, options, channelId, userId: 'u5' });
  await router.handle(fake.asInteraction());
  return fake.responses.map((response) => response.payload as Payload);
}

const contents = (payloads: Payload[]) => payloads.map((payload) => payload.content);

async function rows() {
  return t.database.admin.select().from(widgetItems).orderBy(widgetItems.id);
}

describe('crudSubcommands definitions', () => {
  it('builds create, edit, show, list and delete with the right required options', () => {
    const json = commandToJson(widgetCommand);
    const options = Object.fromEntries(
      (json.options as Array<{ name: string; options: Array<{ name: string; required: boolean; autocomplete?: boolean }> }>).map(
        (sub) => [sub.name, sub.options.map((option) => `${option.name}${option.required ? '!' : ''}${option.autocomplete ? '*' : ''}`)],
      ),
    );
    expect(options).toEqual({
      create: ['id!*', 'label!', 'count'],
      edit: ['id!*', 'label', 'count'],
      show: ['id*'],
      list: [],
      delete: ['id*'],
    });
    expect((json.options as Array<{ type: number }>).every((sub) => sub.type === ApplicationCommandOptionType.Subcommand)).toBe(true);
  });

  it('omits and overrides subcommands, and skips the key option for generated keys', () => {
    const json = commandToJson(gadgetCommand);
    const subs = json.options as Array<{ name: string; description: string; options: Array<{ name: string }> }>;
    expect(subs.map((sub) => sub.name)).toEqual(['create', 'show', 'list', 'delete']);
    expect(subs[0]!.options.map((option) => option.name)).toEqual(['label']);
    expect(subs[2]!.description).toBe('Custom list');
  });

  it('refuses fields that do not fit the table', () => {
    const key = { name: 'id', option: opt.string({ description: 'ID' }), toKey: (value: string) => value };
    expect(() => crudSubcommands(widgets, { key, fields: { size: { option: opt.integer({ description: 'S' }), column: 'size' } } })).toThrow(
      'CRUD field "size" names unknown column "size"',
    );
    expect(() => crudSubcommands(widgets, { key, fields: { id: { option: opt.string({ description: 'I' }), column: 'label' } } })).toThrow(
      'CRUD field "id" has the same name as the key option',
    );
    expect(() => crudSubcommands(widgets, { key, fields: { other: { option: opt.string({ description: 'O' }), column: 'id' } } })).toThrow(
      'CRUD field "other" must not write the key column',
    );
  });
});

describe('create', () => {
  it('writes a record with defaults, runs the hooks and shows it privately', async () => {
    const payloads = await say('widget', 'create', { id: 'w1', label: 'Blue' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.content).toBe('**Widget created.**');
    expect(payloads[0]!.embeds![0]!.data.description).toBe('Blue (1)');
    expect(payloads[0]!.flags).toBeDefined();
    expect(calls).toEqual(['prepare:w1:new:1', 'create:w1']);
    const [row] = await rows();
    expect(row).toMatchObject({ id: 'w1', label: 'Blue', count: 1, guildId: 'g1', createdBy: 'u5' });
  });

  it('uses values from prepare', async () => {
    await say('widget', 'create', { id: 'w1', label: 'shout' });
    expect((await rows())[0]!.label).toBe('SHOUT');
  });

  it('refuses keys that exist, also in another guild', async () => {
    await say('widget', 'create', { id: 'w1', label: 'Blue' });
    expect(contents(await say('widget', 'create', { id: 'w1', label: 'Red' }))).toEqual(['Widget for `w1` already exists.']);
    await createScopedDb(t.database.app, 'g2').run(async (tx) => {
      await tx.insert(widgetItems).values({ id: 'other', label: 'Theirs' });
    });
    expect(contents(await say('widget', 'create', { id: 'other', label: 'Mine' }))).toEqual([
      'Widget for `other` already exists.',
    ]);
    expect((await rows()).map((row) => [row.id, row.label])).toEqual([
      ['other', 'Theirs'],
      ['w1', 'Blue'],
    ]);
  });

  it('stops on validation problems and hook refusals without writing', async () => {
    expect(contents(await say('widget', 'create', { id: 'w1', label: 'Blue', count: -1 }))).toEqual(['Count must not be negative.']);
    expect(contents(await say('widget', 'create', { id: 'w2', label: 'refuse' }))).toEqual(['Prepare refused.']);
    expect(await rows()).toEqual([]);
    expect(calls.filter((call) => call.startsWith('create'))).toEqual([]);
  });

  it('generates keys when configured', async () => {
    const payloads = await say('gadget', 'create', { label: 'Gizmo' });
    expect(payloads[0]!.content).toBe('**Widget created.**');
    expect(payloads[0]!.flags).toBeUndefined();
    expect((await rows()).map((row) => row.id)).toEqual([`gen-${generated}`]);
  });
});

describe('edit', () => {
  beforeEach(async () => {
    await say('widget', 'create', { id: 'w1', label: 'Blue', count: 2 });
    calls.length = 0;
  });

  it('changes only the options that were passed', async () => {
    const payloads = await say('widget', 'edit', { id: 'w1', count: 5 });
    expect(payloads[0]!.content).toBe('**Widget updated.**');
    expect(calls).toEqual(['prepare:w1:Blue:5', 'edit:w1']);
    expect((await rows())[0]).toMatchObject({ label: 'Blue', count: 5, updatedBy: 'u5' });
  });

  it('refuses an edit without changes before running prepare', async () => {
    expect(contents(await say('widget', 'edit', { id: 'w1' }))).toEqual(['Nothing to change; pass at least one option.']);
    expect(calls).toEqual([]);
  });

  it('never changes the key, even when prepare returns one', async () => {
    expect((await say('widget', 'edit', { id: 'w1', label: 'rekey' }))[0]!.content).toBe('**Widget updated.**');
    expect((await rows()).map((row) => [row.id, row.label])).toEqual([['w1', 'rekeyed']]);
  });

  it('validates the merged record', async () => {
    expect(contents(await say('widget', 'edit', { id: 'w1', count: -3 }))).toEqual(['Count must not be negative.']);
    expect((await rows())[0]!.count).toBe(2);
  });
});

describe('show, list and delete', () => {
  it('shows a record by key or by the current channel', async () => {
    await say('widget', 'create', { id: 'w1', label: 'Blue' });
    expect((await say('widget', 'show', { id: 'w1' }))[0]!.embeds![0]!.data.title).toBe('Widget');
    expect((await say('widget', 'show', {}, 'w1'))[0]!.embeds![0]!.data.description).toBe('Blue (1)');
  });

  it('names missing records, including those of other guilds', async () => {
    await createScopedDb(t.database.app, 'g2').run(async (tx) => {
      await tx.insert(widgetItems).values({ id: 'theirs', label: 'Theirs' });
    });
    for (const subcommand of ['show', 'edit', 'delete']) {
      expect(contents(await say('widget', subcommand, { id: 'theirs', label: 'x' }))).toEqual(['There is no widget for `theirs`.']);
    }
    expect((await rows()).map((row) => row.id)).toEqual(['theirs']);
  });

  it('lists records, or says there are none', async () => {
    expect(contents(await say('widget', 'list'))).toEqual(['There are no widgets yet.']);
    await say('widget', 'create', { id: 'w1', label: 'Blue' });
    expect(contents(await say('widget', 'list'))).toEqual(['**1 Widget**\n- Blue (1)']);
    await say('widget', 'create', { id: 'w2', label: 'Red', count: 4 });
    expect(contents(await say('widget', 'list'))).toEqual(['**2 Widgets**\n- Blue (1)\n- Red (4)']);
  });

  it('splits long lists into several messages', async () => {
    const g1 = createScopedDb(t.database.app, 'g1');
    await g1.run(async (tx) => {
      await tx.insert(widgetItems).values(Array.from({ length: 150 }, (_, i) => ({ id: `w${String(i).padStart(3, '0')}`, label: `A rather long widget label ${i}` })));
    });
    const payloads = await say('widget', 'list');
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((payload) => (payload.content ?? '').length <= 2000)).toBe(true);
    expect(payloads.map((payload) => payload.content).join('\n').match(/^- /gm)).toHaveLength(150);
  });

  it('reports a record that disappeared before the delete', async () => {
    await say('widget', 'create', { id: 'w1', label: 'vanish' });
    expect(contents(await say('widget', 'delete', { id: 'w1' }))).toEqual(['There is no widget for `w1`.']);
    expect(await rows()).toEqual([]);
  });

  it('deletes a record after beforeDelete', async () => {
    await say('widget', 'create', { id: 'w1', label: 'Blue' });
    calls.length = 0;
    expect(contents(await say('widget', 'delete', { id: 'w1' }))).toEqual(['**Widget deleted:** Blue (1)']);
    expect(calls).toEqual(['delete:w1']);
    expect(await rows()).toEqual([]);
    expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'w1'))).toEqual([]);
  });
});
