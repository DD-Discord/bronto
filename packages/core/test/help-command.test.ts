import { ButtonStyle, ComponentType, MessageFlags, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTopic } from '../src/docs/paginate.js';
import type { ModuleDocs } from '../src/docs/types.js';
import { commandToJson } from '../src/interactions/commands.js';
import { createCustomId } from '../src/interactions/components.js';
import { createHelp } from '../src/interactions/help-command.js';
import { InteractionRouter } from '../src/interactions/router.js';
import { ComponentSigner } from '../src/interactions/signing.js';
import { createCoreRuntime } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { TEST_INTERACTION_SECRET } from '../src/testing/index.js';
import { fakeAutocomplete, fakeButton, fakeCommand, fakeSelect, type FakeInteraction } from '../src/testing/interactions.js';
import { captureLog } from '../src/testing/log.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterEach(async () => {
  await t.drop();
});

function docs(files: Record<string, string>): ModuleDocs {
  const topics = Object.entries(files).map(([id, source]) => {
    const { topic, problems } = parseTopic(id, source);
    expect(problems).toEqual([]);
    return topic;
  });
  return { summary: topics[0]!.pages[0]![0]!.markdown, topics };
}

function library(): Map<string, ModuleDocs> {
  return new Map([
    ['core', docs({ index: '# Help\n\nCore help.', modules: '# Modules\n\nThe modules command.' })],
    [
      'alpha',
      docs({
        index:
          '# Alpha\n\nAlpha does things.\n\n> [!section] [Open](b.md)\n> **B**\n>\n> About b.\n\n' +
          '> [!section] [Site](https://example.com)\n> The website.',
        b: '# Bee\n\nOne\n\n---\n\nTwo',
      }),
    ],
    ['beta', docs({ index: '# Beta\n\nBeta things.' })],
  ]);
}

interface Payload { components: Component[]; flags?: number; content?: string }
interface Component {
  type: ComponentType;
  content?: string;
  custom_id?: string;
  label?: string;
  style?: ButtonStyle;
  url?: string;
  disabled?: boolean;
  placeholder?: string;
  options?: { label: string; value: string; description?: string; default?: boolean }[];
  components?: Component[];
  accessory?: Component;
}

/** Every component of a message, depth first. */
function all(payload: Payload): Component[] {
  const out: Component[] = [];
  const walk = (component: Component) => {
    out.push(component);
    for (const child of component.components ?? []) walk(child);
    if (component.accessory) walk(component.accessory);
  };
  for (const component of payload.components) walk(component);
  return out;
}

const texts = (payload: Payload) => all(payload).filter((c) => c.type === ComponentType.TextDisplay).map((c) => c.content);
const select = (payload: Payload, placeholder: string) => all(payload).find((c) => c.placeholder === placeholder)!;
const button = (payload: Payload, label: string) =>
  all(payload).find((c) => c.type === ComponentType.Button && c.label === label)!;

function build(input: { navigation?: boolean; library?: Map<string, ModuleDocs> } = {}) {
  const navigation = input.navigation ?? true;
  const disabled = new Set<string>();
  const { log } = captureLog();
  const services = { client: {} as Client, database: t.database, log };
  const signer = navigation ? new ComponentSigner(TEST_INTERACTION_SECRET) : null;
  const enablement = new ModuleEnablement(t.database.admin);
  const queue = new KeyedQueue(() => undefined);
  const dispatcher = new Dispatcher({ runtimes: [], database: t.database, enablement, queue, signer });
  const help = createHelp({
    library: input.library ?? library(),
    enablement: { isEnabled: (_guildId, module) => !disabled.has(module) },
    navigation,
  });
  const router = new InteractionRouter({
    sources: [
      { runtime: createCoreRuntime(services), commands: { help: help.command }, components: help.components, alwaysEnabled: true },
    ],
    dispatcher,
    enablement,
    guildGate: async () => true,
    log,
    signer,
  });
  const answer = async (fake: FakeInteraction, kind: 'reply' | 'update') => {
    await router.handle(fake.asInteraction());
    expect(fake.responses).toHaveLength(1);
    expect(fake.responses[0]!.kind).toBe(kind);
    return fake.responses[0]!.payload as Payload;
  };
  const ask = async (options: Record<string, unknown> = {}) => {
    const payload = await answer(fakeCommand({ command: 'help', options }), 'reply');
    expect(payload.flags).toBe(MessageFlags.Ephemeral | (payload.content === undefined ? MessageFlags.IsComponentsV2 : 0));
    return payload;
  };
  const press = (customId: string) => answer(fakeButton({ customId }), 'update');
  const choose = (customId: string, value: string) => answer(fakeSelect({ customId, values: [value] }), 'update');
  const suggest = async (focused: string, options: Record<string, unknown>) => {
    const fake = fakeAutocomplete({ command: 'help', focused, options });
    await router.handle(fake.asInteraction());
    return (fake.responses[0]!.payload as { name: string; value: string }[]);
  };
  const go = help.components.find((c) => c.name === 'go')!;
  const sign = (args: string[]) => createCustomId(signer!, go, { guildId: 'g1', userId: 'u1', channelId: 'c1' }, args, Date.now());
  return { help, disabled, ask, press, choose, suggest, sign };
}

describe('/help', () => {
  it('is for everyone', () => {
    const json = commandToJson('help', build().help.command);
    expect(json.default_member_permissions).toBeNull();
  });

  it("answers /help with core's index", async () => {
    const { ask } = build();
    const payload = await ask();
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0]!.type).toBe(ComponentType.Container);
    expect(texts(payload)).toEqual(['# Help', 'Core help.']);
  });

  it("answers /help module:alpha with alpha's index", async () => {
    const { ask } = build();
    const payload = await ask({ module: 'alpha' });
    expect(texts(payload)).toEqual(['# Alpha', 'Alpha does things.', '**B**\n\nAbout b.', 'The website.']);
    expect(button(payload, 'Open').style).toBe(ButtonStyle.Secondary);
    expect(button(payload, 'Site')).toMatchObject({ style: ButtonStyle.Link, url: 'https://example.com' });
    expect(select(payload, 'Module').options!.find((o) => o.default)?.value).toBe('alpha');
    expect(select(payload, 'Topic').options!.find((o) => o.default)?.value).toBe('index');
  });

  it('answers /help module:alpha topic:b with the first page of b', async () => {
    const { ask } = build();
    const payload = await ask({ module: 'alpha', topic: 'b' });
    expect(texts(payload)).toEqual(['# Bee', 'One']);
    expect(button(payload, '1 / 2').disabled).toBe(true);
    expect(button(payload, '◀ Back').disabled).toBe(true);
    expect(button(payload, 'Next ▶').disabled).toBe(false);
    expect(select(payload, 'Topic').options!.find((o) => o.default)?.value).toBe('b');
  });

  it('refuses a disabled module', async () => {
    const { ask, disabled } = build();
    disabled.add('alpha');
    expect((await ask({ module: 'alpha' })).content).toBe('There\'s no help for "alpha".');
    expect((await ask({ module: 'gamma' })).content).toBe('There\'s no help for "gamma".');
  });

  it('refuses an unknown topic', async () => {
    const { ask } = build();
    expect((await ask({ module: 'alpha', topic: 'zz' })).content).toBe('There\'s no help topic "zz" in Alpha.');
  });

  it('autocompletes enabled modules', async () => {
    const { suggest, disabled } = build();
    disabled.add('beta');
    expect(await suggest('module', { module: '' })).toEqual([
      { name: 'Help', value: 'core' },
      { name: 'Alpha', value: 'alpha' },
    ]);
    expect(await suggest('module', { module: 'ALP' })).toEqual([{ name: 'Alpha', value: 'alpha' }]);
  });

  it('autocompletes topics of the chosen module', async () => {
    const { suggest } = build();
    expect(await suggest('topic', { module: 'alpha', topic: '' })).toEqual([
      { name: 'Alpha', value: 'index' },
      { name: 'Bee', value: 'b' },
    ]);
    expect(await suggest('topic', { module: 'alpha', topic: 'be' })).toEqual([{ name: 'Bee', value: 'b' }]);
    expect(await suggest('topic', { topic: '' })).toEqual([
      { name: 'Help', value: 'index' },
      { name: 'Modules', value: 'modules' },
    ]);
    expect(await suggest('topic', { module: 'gamma', topic: '' })).toEqual([]);
  });

  it('opens a module from the select', async () => {
    const { ask, choose } = build();
    const first = await ask();
    const payload = await choose(select(first, 'Module').custom_id!, 'beta');
    expect(texts(payload)).toEqual(['# Beta', 'Beta things.']);
  });

  it('opens a topic from the select', async () => {
    const { ask, choose } = build();
    const first = await ask({ module: 'alpha' });
    const payload = await choose(select(first, 'Topic').custom_id!, 'b');
    expect(texts(payload)).toEqual(['# Bee', 'One']);
  });

  it('pages with Back and Next', async () => {
    const { ask, press } = build();
    const first = await ask({ module: 'alpha', topic: 'b' });
    const second = await press(button(first, 'Next ▶').custom_id!);
    expect(texts(second)).toEqual(['# Bee', 'Two']);
    expect(button(second, '2 / 2').disabled).toBe(true);
    expect(button(second, 'Next ▶').disabled).toBe(true);
    const back = await press(button(second, '◀ Back').custom_id!);
    expect(texts(back)).toEqual(['# Bee', 'One']);
  });

  it('opens a topic from a section button', async () => {
    const { ask, press } = build();
    const first = await ask({ module: 'alpha' });
    const payload = await press(button(first, 'Open').custom_id!);
    expect(texts(payload)).toEqual(['# Bee', 'One']);
  });

  it('shows one button per topic link, since Discord rejects duplicate custom IDs', async () => {
    const twice = library();
    twice.set('alpha', docs({
      index: '# Alpha\n\nA.\n\n> [!section] [Open](b.md)\n> First\n\n> [!section] [Again](b.md)\n> Second',
      b: '# Bee\n\nOne\n\n---\n\n> [!section] [Self](b.md)\n> Self link',
    }));
    const { ask, press } = build({ library: twice });
    const index = await ask({ module: 'alpha' });
    expect(all(index).filter((c) => c.type === ComponentType.Section)).toHaveLength(1);
    expect(texts(index)).toContain('Second');
    const second = await press(button(await ask({ module: 'alpha', topic: 'b' }), 'Next ▶').custom_id!);
    const ids = all(second).flatMap((c) => (c.custom_id === undefined ? [] : [c.custom_id]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to core's index for a disabled module", async () => {
    const { press, sign, disabled } = build();
    disabled.add('alpha');
    expect(texts(await press(sign(['alpha', 'b', '1'])))).toEqual(['# Help', 'Core help.']);
  });

  it("falls back to the module's index for a missing topic", async () => {
    const { press, sign } = build();
    expect(texts(await press(sign(['alpha', 'zz', '0'])))[0]).toBe('# Alpha');
  });

  it('falls back to the first page for a page out of range', async () => {
    const { press, sign } = build();
    expect(texts(await press(sign(['alpha', 'b', '9'])))).toEqual(['# Bee', 'One']);
    expect(texts(await press(sign(['alpha', 'b', '-1'])))).toEqual(['# Bee', 'One']);
  });

  it('lists core and 24 modules in the select', async () => {
    const many = library();
    many.delete('alpha');
    many.delete('beta');
    const names = Array.from({ length: 30 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
    for (const name of names) many.set(name, docs({ index: `# Module ${name}\n\nAbout ${name}.` }));
    const { ask, suggest } = build({ library: many });
    const options = select(await ask(), 'Module').options!;
    expect(options).toHaveLength(25);
    expect(options[0]).toEqual({ label: 'Help', value: 'core', description: 'Core help.', default: true });
    expect(options[24]).toEqual({ label: 'Module m24', value: 'm24', description: 'About m24.', default: false });
    expect(await suggest('module', { module: '' })).toHaveLength(25);
    expect(await suggest('module', { module: 'm30' })).toEqual([{ name: 'Module m30', value: 'm30' }]);
  });

  it('renders without navigation', async () => {
    const { ask } = build({ navigation: false });
    const index = await ask({ module: 'alpha' });
    expect(all(index).some((c) => c.type === ComponentType.ActionRow)).toBe(false);
    expect(all(index).some((c) => c.type === ComponentType.TextDisplay && c.content === '**B**\n\nAbout b.')).toBe(true);
    const sections = all(index).filter((c) => c.type === ComponentType.Section);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.accessory).toMatchObject({ style: ButtonStyle.Link, url: 'https://example.com' });
    const topic = await ask({ module: 'alpha', topic: 'b' });
    expect(texts(topic)).toEqual(['# Bee', 'One']);
    expect(all(topic).some((c) => c.type === ComponentType.Button)).toBe(false);
  });

  it('fits the custom ID budget', async () => {
    const module = 'a'.repeat(43);
    const topic = 't'.repeat(32);
    const big = library();
    const index = `# Long\n\n> [!section] [Open](${topic}.md)\n> Text`;
    big.set(module, docs({ index, [topic]: '# Topic\n\nOne\n\n---\n\nTwo' }));
    const { ask } = build({ library: big });
    for (const payload of [await ask({ module }), await ask({ module, topic })]) {
      const ids = all(payload).flatMap((c) => (c.custom_id === undefined ? [] : [c.custom_id]));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(id.length).toBeLessThanOrEqual(100);
    }
  });
});
