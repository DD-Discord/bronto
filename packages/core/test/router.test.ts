import { MessageFlags } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertGuild } from '../src/db/guilds.js';
import { defineCommand, defineSubcommand, type CommandDefinition } from '../src/interactions/commands.js';
import { createCustomId, defineButton, defineModal, defineSelect, type ComponentDefinition } from '../src/interactions/components.js';
import { ComponentSigner } from '../src/interactions/signing.js';
import { UserError } from '../src/interactions/errors.js';
import { opt } from '../src/interactions/options.js';
import { DONE, GENERIC_FAILURE } from '../src/interactions/responder.js';
import {
  COMPONENT_EXPIRED,
  COMPONENT_GONE,
  COMPONENT_UNAVAILABLE,
  InteractionRouter,
  NOT_AVAILABLE,
  NOT_READY,
  type InteractionSource,
} from '../src/interactions/router.js';
import { ConfigError } from '../src/config/errors.js';
import { createCoreRuntime, createModuleRuntimes, type ModuleRuntime } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { defineModule } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { FakeClient } from '../src/testing/fake-client.js';
import { fakeAutocomplete, fakeButton, fakeCommand, fakeModal, fakeSelect, type FakeInteraction } from '../src/testing/interactions.js';
import { captureLog, type LogLine } from '../src/testing/log.js';
import { widgetsMigrations } from './fixtures/widgets/module.js';
import * as widgetsSchema from './fixtures/widgets/schema.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ran: string[] = [];

const demoCommand = defineCommand({
  description: 'Demo',
  subcommands: {
    echo: defineSubcommand({
      description: 'Echoes',
      options: { text: opt.string({ description: 'Text', required: true }), times: opt.integer({ description: 'Times' }) },
      execute: async (ctx, { text, times }) => {
        ran.push('echo');
        await ctx.reply(`${text} x${times ?? 1}`);
      },
    }),
    write: defineSubcommand({
      description: 'Writes a widget',
      execute: async (ctx) => {
        await ctx.db.run(async (tx) => {
          await tx.insert(widgetItems).values({ id: 'w1', label: 'from a command' });
        });
        await ctx.reply('written');
      },
    }),
    slow: defineSubcommand({
      description: 'Slow',
      ephemeral: true,
      execute: async (ctx) => {
        await sleep(120);
        await ctx.reply('late');
      },
    }),
    'slow-refuse': defineSubcommand({
      description: 'Slow refusal',
      execute: async () => {
        await sleep(120);
        throw new UserError('Refused late.');
      },
    }),
    refuse: defineSubcommand({
      description: 'Refuses',
      execute: () => {
        throw new UserError('That is not allowed.');
      },
    }),
    oops: defineSubcommand({
      description: 'Breaks',
      execute: () => {
        throw new Error('database exploded');
      },
    }),
    silent: defineSubcommand({ description: 'Says nothing', execute: () => undefined }),
    pick: defineSubcommand({
      description: 'Picks',
      options: {
        thing: opt.string({
          description: 'Thing',
          autocomplete: (_ctx, query) => {
            if (query === 'fail') throw new Error('autocomplete broke');
            if (query === 'refuse') throw new UserError('No suggestions.');
            if (query === 'blank') {
              return [
                { name: ' ', value: 'v-blank' },
                { name: '', value: '' },
                { name: '', value: 42 },
                { name: '', value: 'y'.repeat(100) },
                { name: 'ok', value: 'ok' },
              ];
            }
            return [
              { name: 'long value', value: 'x'.repeat(101) },
              { name: 'n'.repeat(150), value: 'long-name' },
              ...Array.from({ length: 30 }, (_, i) => ({ name: `${query}-${i}`, value: `v${i}` })),
            ];
          },
        }),
      },
      execute: () => undefined,
    }),
  },
});

const press = defineButton({
  name: 'press',
  ephemeral: true,
  execute: async (ctx, args) => {
    await ctx.reply(`pressed ${args.join(',')}`);
  },
});

const slowUpdate = defineButton({
  name: 'slow-update',
  defer: 'update',
  execute: async (ctx) => {
    await sleep(150);
    await ctx.update('redrawn');
  },
});

const choose = defineSelect({
  name: 'choose',
  bind: { channel: true },
  ephemeral: true,
  execute: async (ctx, args) => {
    await ctx.reply(`chose ${ctx.values.join(',')} with ${args.join(',')}`);
  },
});

const chooseModal = defineSelect({
  name: 'choose-modal',
  execute: async (ctx) => {
    await ctx.showModal({ custom_id: 'x', title: 'Pick', components: [] });
  },
});

const form = defineModal({
  name: 'form',
  execute: async (ctx, args) => {
    await ctx.reply(`${args[0]}: ${ctx.field('body')}`);
  },
});

const brief = defineButton({
  name: 'brief',
  expiresAfterMs: 60_000,
  execute: async (ctx) => {
    await ctx.reply('in time');
  },
});

// Bound to the presser and channel; a press hands out a fresh ID for the same button, signed by the handler.
const mine = defineButton({
  name: 'mine',
  bind: { user: true, channel: true },
  execute: async (ctx, args) => {
    await ctx.reply(ctx.customId(mine, [...args, 'again']));
  },
});

// Owns the widgets schema, so its /demo write subcommand can write widget items.
const demo = defineModule({
  name: 'widgets',
  db: { schema: widgetsSchema, migrations: widgetsMigrations },
  commands: { demo: demoCommand },
  components: [press, form, brief, mine, slowUpdate, choose, chooseModal],
});

let t: TestDatabase;
let lines: LogLine[];
let handlerLines: LogLine[];
let enablement: ModuleEnablement;
let runtimes: ModuleRuntime[];
let dispatcher: Dispatcher;
let gateOpen: boolean;
let gateDelayMs: number;
let now: number;

const signer = new ComponentSigner('s'.repeat(32));
const sign = (
  component: ComponentDefinition,
  args: string[] = [],
  target: { guildId?: string; userId?: string; channelId?: string } = {},
) => createCustomId(signer, component, { guildId: 'g1', userId: 'u1', channelId: 'c1', ...target }, args, now);

function makeRouter(sources?: InteractionSource[], deferAfterMs = 40): InteractionRouter {
  const captured = captureLog();
  lines = captured.lines;
  return new InteractionRouter({
    sources: sources ?? [{ runtime: runtimes[0]!, commands: { demo: demoCommand }, components: [press, form, brief, mine, slowUpdate, choose, chooseModal] }],
    dispatcher,
    signer,
    now: () => now,
    enablement,
    guildGate: async () => {
      if (gateDelayMs > 0) await sleep(gateDelayMs);
      return gateOpen;
    },
    log: captured.log,
    deferAfterMs,
  });
}

async function run(router: InteractionRouter, fake: FakeInteraction): Promise<FakeInteraction> {
  await router.handle(fake.asInteraction());
  return fake;
}

const privately = (content: string) => ({
  content,
  allowedMentions: { parse: [] },
  flags: MessageFlags.Ephemeral,
});

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await upsertGuild(t.database.admin, 'g1');
  const client = new FakeClient().asClient();
  const { log, lines: captured } = captureLog();
  handlerLines = captured;
  runtimes = createModuleRuntimes([{ packageName: '@test/widgets', definition: demo, config: {} }], {
    client,
    database: t.database,
    log,
  });
  enablement = new ModuleEnablement(t.database.admin);
  dispatcher = new Dispatcher({
    runtimes,
    database: t.database,
    enablement,
    queue: new KeyedQueue(() => undefined),
    signer,
    now: () => now,
  });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  ran.length = 0;
  gateOpen = true;
  gateDelayMs = 0;
  now = 1_000_000;
  await enablement.set('g1', 'widgets', true);
});

describe('InteractionRouter commands', () => {
  it('routes a subcommand with typed options', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'hi', times: 2 } }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: { content: 'hi x2', allowedMentions: { parse: [] } } }]);
  });

  it('runs the handler as the user who used the command', async () => {
    await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'write', userId: 'u42' }));
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'w1'));
    expect(row?.createdBy).toBe('u42');
  });

  it('defers slow commands with the subcommand visibility and edits the answer', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'slow' }));
    expect(fake.responses).toEqual([
      { kind: 'deferReply', payload: { flags: MessageFlags.Ephemeral } },
      { kind: 'editReply', payload: { content: 'late', allowedMentions: { parse: [] } } },
    ]);
  });

  it('reports a UserError thrown after a public defer privately', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'slow-refuse' }));
    expect(fake.responses.map((response) => response.kind)).toEqual(['deferReply', 'deleteReply', 'followUp']);
    expect(fake.responses[2]!.payload).toEqual(privately('Refused late.'));
  });

  it('shows a UserError privately and logs it at debug level only', async () => {
    handlerLines.length = 0;
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'refuse' }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately('That is not allowed.') }]);
    expect(handlerLines.map((line) => [line.level, line.msg])).toEqual([[20, 'Handler stopped']]);
  });

  it('hides other errors behind a generic message and logs them with module, command and guild', async () => {
    handlerLines.length = 0;
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'oops' }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(GENERIC_FAILURE) }]);
    expect(handlerLines).toContainEqual(
      expect.objectContaining({ level: 50, msg: 'Handler failed', module: 'widgets', handler: '/demo oops', guildId: 'g1' }),
    );
  });

  it('answers Done when the handler never replied', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'silent' }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(DONE) }]);
  });

  it('refuses stale commands without running anything', async () => {
    const router = makeRouter();
    const unknown = await run(router, fakeCommand({ command: 'gone' }));
    const removed = await run(router, fakeCommand({ command: 'demo', subcommand: 'removed' }));
    await enablement.set('g1', 'widgets', false);
    const disabled = await run(router, fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'x' } }));
    for (const fake of [unknown, removed, disabled]) {
      expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(NOT_AVAILABLE) }]);
    }
    expect(ran).toEqual([]);
  });

  it('tells the user to wait while the guild is not set up', async () => {
    gateOpen = false;
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'x' } }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(NOT_READY) }]);
    expect(ran).toEqual([]);
  });

  it('defers while waiting for a slow guild gate', async () => {
    gateDelayMs = 120;
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'hi' } }));
    expect(fake.responses).toEqual([
      { kind: 'deferReply', payload: {} },
      { kind: 'editReply', payload: { content: 'hi x1', allowedMentions: { parse: [] } } },
    ]);
  });

  it('reports a guild that is still not ready after a slow gate', async () => {
    gateDelayMs = 120;
    gateOpen = false;
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'hi' } }));
    expect(fake.responses.map((response) => response.kind)).toEqual(['deferReply', 'deleteReply', 'followUp']);
    expect(fake.responses[2]!.payload).toEqual(privately(NOT_READY));
  });

  it('logs answers Discord rejects instead of throwing', async () => {
    const router = makeRouter();
    await run(router, fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'x' }, rejectResponses: true }));
    expect(lines.some((line) => line.msg === 'Answering an interaction failed')).toBe(true);
  });

  it('ignores interactions outside a guild', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'echo', guildId: null }));
    expect(fake.responses).toEqual([]);
  });

  it('tells the user to wait in a guild that is not cached yet', async () => {
    const router = makeRouter();
    const command = await run(router, fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'x' }, cached: false }));
    const button = await run(router, fakeButton({ customId: sign(press), cached: false }));
    for (const fake of [command, button]) {
      expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(NOT_READY) }]);
    }
    const autocomplete = await run(
      router,
      fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing', options: { thing: 'ab' }, cached: false }),
    );
    expect(autocomplete.responses).toEqual([{ kind: 'respond', payload: [] }]);
    expect(ran).toEqual([]);
  });
});

describe('InteractionRouter autocomplete', () => {
  it('caps choices at 25 and drops values Discord would reject', async () => {
    const fake = await run(
      makeRouter(),
      fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing', options: { thing: 'ab' } }),
    );
    const choices = fake.responses[0]!.payload as Array<{ name: string; value: string }>;
    expect(choices).toHaveLength(25);
    expect(choices.some((choice) => choice.name === 'long value')).toBe(false);
    expect(choices[0]).toEqual({ name: `${'n'.repeat(99)}…`, value: 'long-name' });
    expect(choices[0]!.name).toHaveLength(100);
    expect(choices[1]).toEqual({ name: 'ab-0', value: 'v0' });
  });

  it('names choices without a name after their value and drops those without either', async () => {
    const fake = await run(
      makeRouter(),
      fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing', options: { thing: 'blank' } }),
    );
    expect(fake.responses[0]!.payload).toEqual([
      { name: 'v-blank', value: 'v-blank' },
      { name: '42', value: 42 },
      { name: 'y'.repeat(100), value: 'y'.repeat(100) },
      { name: 'ok', value: 'ok' },
    ]);
  });

  it('logs a UserError from autocomplete at debug level only', async () => {
    handlerLines.length = 0;
    const fake = await run(
      makeRouter(),
      fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing', options: { thing: 'refuse' } }),
    );
    expect(fake.responses).toEqual([{ kind: 'respond', payload: [] }]);
    expect(handlerLines.map((line) => [line.level, line.msg])).toEqual([[20, 'Handler stopped']]);
  });

  it('answers with no choices on failure, for disabled modules and for options without autocomplete', async () => {
    const router = makeRouter();
    const failing = await run(router, fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing', options: { thing: 'fail' } }));
    const plain = await run(router, fakeAutocomplete({ command: 'demo', subcommand: 'echo', focused: 'text' }));
    await enablement.set('g1', 'widgets', false);
    const disabled = await run(router, fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing' }));
    for (const fake of [failing, plain, disabled]) {
      expect(fake.responses).toEqual([{ kind: 'respond', payload: [] }]);
    }
  });
});

describe('InteractionRouter components', () => {
  it('a slow button with defer "update" is deferred with deferUpdate', async () => {
    const fake = await run(makeRouter(), fakeButton({ customId: sign(slowUpdate) }));
    expect(fake.responses).toEqual([
      { kind: 'deferUpdate', payload: undefined },
      { kind: 'editReply', payload: { content: 'redrawn', allowedMentions: { parse: [] } } },
    ]);
  });

  it('routes buttons and modals with their custom ID arguments', async () => {
    const router = makeRouter();
    const button = await run(router, fakeButton({ customId: sign(press, ['a', 'b']) }));
    expect(button.responses).toEqual([{ kind: 'reply', payload: privately('pressed a,b') }]);
    const modal = await run(router, fakeModal({ customId: sign(form, ['n1']), fields: { body: 'text' } }));
    expect(modal.responses).toEqual([{ kind: 'reply', payload: { content: 'n1: text', allowedMentions: { parse: [] } } }]);
  });

  it('refuses unknown and disabled components', async () => {
    const router = makeRouter();
    const unknown = await run(router, fakeButton({ customId: 'demo:missing' }));
    const garbage = await run(router, fakeButton({ customId: 'garbage' }));
    const wrongKind = await run(router, fakeButton({ customId: sign(form, ['x']) }));
    for (const fake of [unknown, garbage, wrongKind]) {
      expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
    }
    await enablement.set('g1', 'widgets', false);
    const disabled = await run(router, fakeButton({ customId: sign(press) }));
    expect(disabled.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_UNAVAILABLE) }]);
  });

  it('refuses tampered IDs without running the handler', async () => {
    const router = makeRouter();
    const tampered = sign(press, ['a']).replace(':a:', ':b:');
    const otherGuild = sign(press, ['a'], { guildId: 'g2' });
    for (const customId of [tampered, otherGuild, 'widgets:press', 'widgets:press:!!!', 'widgets:press:a:b:c']) {
      const fake = await run(router, fakeButton({ customId }));
      expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
    }
    expect(lines.filter((line) => line.msg === 'Rejected a component custom ID')).toHaveLength(5);
  });

  it('answers expired IDs with COMPONENT_EXPIRED', async () => {
    const router = makeRouter();
    const customId = sign(brief);
    now += 59_000;
    const early = await run(router, fakeButton({ customId }));
    expect(early.responses).toEqual([{ kind: 'reply', payload: { content: 'in time', allowedMentions: { parse: [] } } }]);
    now += 2_000;
    const late = await run(router, fakeButton({ customId }));
    expect(late.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_EXPIRED) }]);
  });

  it('refuses a modal submitted by another user', async () => {
    const router = makeRouter();
    const fake = await run(router, fakeModal({ customId: sign(form, ['n1']), fields: { body: 'text' }, userId: 'u2' }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
  });

  it('checks bound buttons against the presser and channel and signs new IDs for them', async () => {
    const router = makeRouter();
    const customId = sign(mine, ['a'], { userId: 'u2', channelId: 'c2' });
    const wrongUser = await run(router, fakeButton({ customId, channelId: 'c2' }));
    const wrongChannel = await run(router, fakeButton({ customId, userId: 'u2' }));
    for (const fake of [wrongUser, wrongChannel]) {
      expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
    }
    const pressed = await run(router, fakeButton({ customId, userId: 'u2', channelId: 'c2' }));
    const again = (pressed.responses[0]!.payload as { content: string }).content;
    expect(again).toBe(sign(mine, ['a', 'again'], { userId: 'u2', channelId: 'c2' }));
  });

  it('refuses every component when no secret is configured', async () => {
    const captured = captureLog();
    const router = new InteractionRouter({
      sources: [{ runtime: runtimes[0]!, commands: {}, components: [press] }],
      dispatcher,
      enablement,
      guildGate: async () => true,
      log: captured.log,
      signer: null,
    });
    const fake = await run(router, fakeButton({ customId: sign(press) }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
  });
});

describe('InteractionRouter selects', () => {
  it('routes a signed select with its values', async () => {
    const customId = sign(choose, ['a'], { channelId: 'c1' });
    const fake = await run(makeRouter(), fakeSelect({ customId, values: ['x', 'y'] }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately('chose x,y with a') }]);
  });

  it('rejects a select signed for another channel', async () => {
    const customId = sign(choose, ['a'], { channelId: 'c2' });
    const fake = await run(makeRouter(), fakeSelect({ customId, values: ['x'] }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
  });

  it('a select may open a modal', async () => {
    const fake = await run(makeRouter(), fakeSelect({ customId: sign(chooseModal), values: ['x'] }));
    expect(fake.responses).toEqual([{ kind: 'showModal', payload: { custom_id: 'x', title: 'Pick', components: [] } }]);
  });

  it('refuses a select ID presented as a button', async () => {
    const fake = await run(makeRouter(), fakeButton({ customId: sign(chooseModal) }));
    expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
  });
});

describe('InteractionRouter setup', () => {
  it('lists the commands of enabled modules plus always-enabled ones', async () => {
    const coreCommand = defineCommand({ description: 'Modules', execute: () => undefined });
    const core = createCoreRuntime({ client: new FakeClient().asClient(), database: t.database, log: captureLog().log });
    const router = makeRouter([
      { runtime: core, commands: { modules: coreCommand }, components: [], alwaysEnabled: true },
      { runtime: runtimes[0]!, commands: { demo: demoCommand }, components: [] },
    ]);
    expect(router.commandsFor('g1').map(([name]) => name)).toEqual(['modules', 'demo']);
    await enablement.set('g1', 'widgets', false);
    expect(router.commandsFor('g1').map(([name]) => name)).toEqual(['modules']);
  });

  it('refuses two modules defining the same command', () => {
    const error = (() => {
      try {
        makeRouter([
          { runtime: runtimes[0]!, commands: { demo: demoCommand }, components: [] },
          { runtime: { ...runtimes[0]!, name: 'other' }, commands: { demo: demoCommand }, components: [] },
        ]);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual(['modules: command /demo is defined by both "widgets" and "other"']);
  });

  it('refuses commands whose JSON Discord would reject', () => {
    const bad: CommandDefinition = {
      description: 'Bad',
      permissions: null,
      nsfw: false,
      handler: { description: 'Bad', options: { ignoreBots: opt.boolean({ description: 'Ignore bots' }) }, execute: () => undefined },
      subcommands: {},
      groups: {},
    };
    expect(() => makeRouter([{ runtime: runtimes[0]!, commands: { demo: demoCommand, bad }, components: [] }])).toThrow(
      expect.objectContaining({
        problems: ['modules: command /bad (widgets): Option name "ignoreBots" must be 1 to 32 lowercase letters, digits, "-" or "_".'],
      }),
    );
  });
});
