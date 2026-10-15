import { MessageFlags } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertGuild } from '../src/db/guilds.js';
import { defineCommand, defineSubcommand } from '../src/interactions/commands.js';
import { defineButton, defineModal } from '../src/interactions/components.js';
import { UserError } from '../src/interactions/errors.js';
import { opt } from '../src/interactions/options.js';
import { DONE, GENERIC_FAILURE } from '../src/interactions/responder.js';
import {
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
import { fakeAutocomplete, fakeButton, fakeCommand, fakeModal, type FakeInteraction } from '../src/testing/interactions.js';
import { captureLog, type LogLine } from '../src/testing/log.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ran: string[] = [];

const demoCommand = defineCommand({
  name: 'demo',
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
            return [
              ...Array.from({ length: 30 }, (_, i) => ({ name: `${query}-${i}`, value: `v${i}` })),
              { name: 'long value', value: 'x'.repeat(101) },
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

const form = defineModal({
  name: 'form',
  execute: async (ctx, args) => {
    await ctx.reply(`${args[0]}: ${ctx.field('body')}`);
  },
});

const demo = defineModule({ name: 'demo', commands: [demoCommand], components: [press, form] });

let t: TestDatabase;
let lines: LogLine[];
let handlerLines: LogLine[];
let enablement: ModuleEnablement;
let runtimes: ModuleRuntime[];
let dispatcher: Dispatcher;
let gateOpen: boolean;

function makeRouter(sources?: InteractionSource[], deferAfterMs = 40): InteractionRouter {
  const captured = captureLog();
  lines = captured.lines;
  return new InteractionRouter({
    sources: sources ?? [{ runtime: runtimes[0]!, commands: [demoCommand], components: [press, form] }],
    dispatcher,
    enablement,
    guildGate: async () => gateOpen,
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
  runtimes = createModuleRuntimes([{ packageName: '@test/demo', definition: demo, config: {} }], {
    client,
    database: t.database,
    log,
  });
  enablement = new ModuleEnablement(t.database.admin);
  dispatcher = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  ran.length = 0;
  gateOpen = true;
  await enablement.set('g1', 'demo', true);
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

  it('reports a UserError thrown after the defer', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'slow-refuse' }));
    expect(fake.responses.map((response) => response.kind)).toEqual(['deferReply', 'editReply']);
    expect(fake.responses[1]!.payload).toMatchObject({ content: 'Refused late.' });
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
      expect.objectContaining({ level: 50, msg: 'Handler failed', module: 'demo', handler: '/demo oops', guildId: 'g1' }),
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
    await enablement.set('g1', 'demo', false);
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

  it('logs answers Discord rejects instead of throwing', async () => {
    const router = makeRouter();
    await run(router, fakeCommand({ command: 'demo', subcommand: 'echo', options: { text: 'x' }, rejectResponses: true }));
    expect(lines.some((line) => line.msg === 'Answering an interaction failed')).toBe(true);
  });

  it('ignores interactions outside a guild', async () => {
    const fake = await run(makeRouter(), fakeCommand({ command: 'demo', subcommand: 'echo', guildId: null }));
    expect(fake.responses).toEqual([]);
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
    expect(choices[0]).toEqual({ name: 'ab-0', value: 'v0' });
  });

  it('answers with no choices on failure, for disabled modules and for options without autocomplete', async () => {
    const router = makeRouter();
    const failing = await run(router, fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing', options: { thing: 'fail' } }));
    const plain = await run(router, fakeAutocomplete({ command: 'demo', subcommand: 'echo', focused: 'text' }));
    await enablement.set('g1', 'demo', false);
    const disabled = await run(router, fakeAutocomplete({ command: 'demo', subcommand: 'pick', focused: 'thing' }));
    for (const fake of [failing, plain, disabled]) {
      expect(fake.responses).toEqual([{ kind: 'respond', payload: [] }]);
    }
  });
});

describe('InteractionRouter components', () => {
  it('routes buttons and modals with their custom ID arguments', async () => {
    const router = makeRouter();
    const button = await run(router, fakeButton({ customId: press.customId('a', 'b') }));
    expect(button.responses).toEqual([{ kind: 'reply', payload: privately('pressed a,b') }]);
    const modal = await run(router, fakeModal({ customId: form.customId('n1'), fields: { body: 'text' } }));
    expect(modal.responses).toEqual([{ kind: 'reply', payload: { content: 'n1: text', allowedMentions: { parse: [] } } }]);
  });

  it('refuses unknown and disabled components', async () => {
    const router = makeRouter();
    const unknown = await run(router, fakeButton({ customId: 'demo:missing' }));
    const garbage = await run(router, fakeButton({ customId: 'garbage' }));
    const wrongKind = await run(router, fakeButton({ customId: form.customId('x') }));
    for (const fake of [unknown, garbage, wrongKind]) {
      expect(fake.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_GONE) }]);
    }
    await enablement.set('g1', 'demo', false);
    const disabled = await run(router, fakeButton({ customId: press.customId() }));
    expect(disabled.responses).toEqual([{ kind: 'reply', payload: privately(COMPONENT_UNAVAILABLE) }]);
  });
});

describe('InteractionRouter setup', () => {
  it('lists the commands of enabled modules plus always-enabled ones', async () => {
    const coreCommand = defineCommand({ name: 'modules', description: 'Modules', execute: () => undefined });
    const core = createCoreRuntime({ client: new FakeClient().asClient(), database: t.database, log: captureLog().log });
    const router = makeRouter([
      { runtime: core, commands: [coreCommand], components: [], alwaysEnabled: true },
      { runtime: runtimes[0]!, commands: [demoCommand], components: [] },
    ]);
    expect(router.commandsFor('g1').map((command) => command.name)).toEqual(['modules', 'demo']);
    await enablement.set('g1', 'demo', false);
    expect(router.commandsFor('g1').map((command) => command.name)).toEqual(['modules']);
  });

  it('refuses two modules defining the same command', () => {
    const error = (() => {
      try {
        makeRouter([
          { runtime: runtimes[0]!, commands: [demoCommand], components: [] },
          { runtime: { ...runtimes[0]!, name: 'other' }, commands: [demoCommand], components: [] },
        ]);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual(['modules: command /demo is defined by both "demo" and "other"']);
  });
});
