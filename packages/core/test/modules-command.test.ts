import { MessageFlags, PermissionFlagsBits, type Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandToJson } from '../src/interactions/commands.js';
import { createModulesCommand } from '../src/interactions/modules-command.js';
import { InteractionRouter } from '../src/interactions/router.js';
import { createCoreRuntime, createModuleRuntimes } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { GuildLifecycle } from '../src/runtime/lifecycle.js';
import { defineModule } from '../src/runtime/module.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { fakeAutocomplete, fakeCommand } from '../src/testing/interactions.js';
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

function build(optional = false) {
  const alpha = defineModule({ name: 'alpha' });
  const beta = defineModule(optional ? { name: 'beta', optionalDependsOn: [alpha] } : { name: 'beta', dependsOn: [alpha] });
  const { log } = captureLog();
  const services = { client: {} as Client, database: t.database, log };
  const runtimes = createModuleRuntimes(
    [alpha, beta].map((definition) => ({ packageName: `@test/${definition.name}`, definition, config: {} })),
    services,
  );
  const enablement = new ModuleEnablement(t.database.admin);
  const dispatcher = new Dispatcher({ runtimes, database: t.database, enablement, queue: new KeyedQueue(() => undefined) });
  const lifecycle = new GuildLifecycle({ runtimes, dispatcher, enablement, database: t.database, commands: { sync: async () => undefined } });
  const command = createModulesCommand({
    runtimes,
    enablement,
    setModuleEnabled: (guildId, module, enabled, actorId, check) =>
      lifecycle.setModuleEnabled(guildId, module, enabled, actorId, check),
  });
  const router = new InteractionRouter({
    sources: [{ runtime: createCoreRuntime(services), commands: { modules: command }, components: [], alwaysEnabled: true }],
    dispatcher,
    enablement,
    guildGate: async (guildId) => {
      await lifecycle.ready(guildId);
      return true;
    },
    log,
    signer: null,
  });
  const say = async (subcommand: string, options: Record<string, unknown> = {}) => {
    const fake = fakeCommand({ command: 'modules', subcommand, options });
    await router.handle(fake.asInteraction());
    await dispatcher.idle();
    expect(fake.responses).toHaveLength(1);
    const payload = fake.responses[0]!.payload as { content: string; flags?: number };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    return payload.content;
  };
  return { command, router, enablement, say };
}

describe('/modules', () => {
  it('is for administrators', () => {
    expect(commandToJson('modules', build().command).default_member_permissions).toBe(String(PermissionFlagsBits.Administrator));
  });

  it('lists the modules and their state in this server', async () => {
    const { say } = build();
    expect(await say('list')).toBe('- **alpha** (`@test/alpha`): on\n- **beta** (`@test/beta`): on');
    await say('disable', { module: 'beta' });
    expect(await say('list')).toBe('- **alpha** (`@test/alpha`): on\n- **beta** (`@test/beta`): off');
  });

  it('switches modules off and on', async () => {
    const { say, enablement } = build();
    expect(await say('disable', { module: 'beta' })).toBe('Turned off **beta**.');
    expect(enablement.isEnabled('g1', 'beta')).toBe(false);
    expect(await say('disable', { module: 'beta' })).toBe('**beta** is already off.');
    expect(await say('enable', { module: 'beta' })).toBe('Turned on **beta**.');
    expect(await say('enable', { module: 'beta' })).toBe('**beta** is already on.');
  });

  it('keeps dependencies consistent', async () => {
    const { say } = build();
    expect(await say('disable', { module: 'alpha' })).toBe('Turn off **beta** first; it depends on **alpha**.');
    await say('disable', { module: 'beta' });
    expect(await say('disable', { module: 'alpha' })).toBe('Turned off **alpha**.');
    expect(await say('enable', { module: 'beta' })).toBe('Turn on **alpha** first; **beta** depends on it.');
  });

  it('ignores optional dependencies when switching modules', async () => {
    const { say, enablement } = build(true);
    expect(await say('disable', { module: 'alpha' })).toBe('Turned off **alpha**.');
    expect(await say('disable', { module: 'beta' })).toBe('Turned off **beta**.');
    expect(await say('enable', { module: 'beta' })).toBe('Turned on **beta**.');
    expect(enablement.isEnabled('g1', 'alpha')).toBe(false);
    expect(enablement.isEnabled('g1', 'beta')).toBe(true);
  });

  it('checks dependencies against switches that ran before', async () => {
    const { say, enablement } = build();
    await say('disable', { module: 'beta' });
    const [disabled, enabled] = await Promise.all([say('disable', { module: 'alpha' }), say('enable', { module: 'beta' })]);
    expect(disabled).toBe('Turned off **alpha**.');
    expect(enabled).toBe('Turn on **alpha** first; **beta** depends on it.');
    expect(enablement.isEnabled('g1', 'beta')).toBe(false);
  });

  it('names unknown modules', async () => {
    const { say } = build();
    expect(await say('enable', { module: 'gamma' })).toBe('There is no module called "gamma".');
  });

  it('suggests loaded module names', async () => {
    const { router } = build();
    const fake = fakeAutocomplete({ command: 'modules', subcommand: 'enable', focused: 'module', options: { module: 'BE' } });
    await router.handle(fake.asInteraction());
    expect(fake.responses).toEqual([{ kind: 'respond', payload: [{ name: 'beta', value: 'beta' }] }]);
  });
});
