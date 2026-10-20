import { Events, type Client, type Guild, type Interaction } from 'discord.js';
import type { Logger } from 'pino';
import { ConfigError } from '../config/errors.js';
import type { CoreConfig } from '../config/schema.js';
import { checkRoles, formatSchemaProblems } from '../db/checks.js';
import type { Database } from '../db/database.js';
import { prepareDatabase } from '../db/prepare.js';
import { listMigratedModules } from '../db/purge.js';
import { commandToJson } from '../interactions/commands.js';
import { createModulesCommand } from '../interactions/modules-command.js';
import { InteractionRouter } from '../interactions/router.js';
import { ComponentSigner } from '../interactions/signing.js';
import { CommandSync, restCommandRegistry } from '../interactions/sync.js';
import { createCoreRuntime, createModuleRuntimes, type ModuleRuntime } from './context.js';
import { Dispatcher } from './dispatcher.js';
import { ModuleEnablement } from './enablement.js';
import { serializeError } from './error-log.js';
import { GuildLifecycle } from './lifecycle.js';
import type { LoadedModule } from './loader.js';
import { KeyedQueue } from './queue.js';
import { migrationTargets, schemaExpectations } from './schema-targets.js';

const DAY_MS = 86_400_000;

/** The bot cannot start; `problems` lists one line per reason. */
export class StartupError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'StartupError';
    this.problems = problems;
  }
}

export interface BotOptions {
  config: CoreConfig;
  /** Loaded modules, sorted by dependencies (as loadModules returns them). */
  modules: LoadedModule[];
  database: Database;
  client: Client;
  log: Logger;
  /** Time between purges of guilds past their grace period; one day by default. */
  purgeIntervalMs?: number;
  /** Time after which an unanswered interaction is deferred; 2 s by default. */
  deferAfterMs?: number;
  /** Clock for custom ID expiry, in milliseconds; Date.now by default. */
  now?: () => number;
}

export interface Bot {
  readonly runtimes: ModuleRuntime[];
  readonly dispatcher: Dispatcher;
  readonly enablement: ModuleEnablement;
  readonly lifecycle: GuildLifecycle;
  readonly router: InteractionRouter;
  readonly commands: CommandSync;
  /** Migrates, grants and checks the database; throws StartupError when it is unsafe to run. */
  prepare(): Promise<void>;
  /** Prepares the database, attaches the gateway listeners and logs in. */
  start(): Promise<void>;
  /** Resolves once no started work is still running. */
  idle(): Promise<void>;
  /** Stops scheduled work, waits for running work and disconnects. The caller closes the database. */
  stop(): Promise<void>;
}

export function createBot(options: BotOptions): Bot {
  const { config, modules, database, client } = options;
  const log = options.log.child({}, { serializers: { err: serializeError } });
  const secret = config.interactions.secret;
  if (secret === undefined && modules.some((module) => (module.definition.components ?? []).length > 0)) {
    throw new ConfigError(['interactions.secret: required because a module defines buttons or modals']);
  }
  const signer = secret === undefined ? null : new ComponentSigner(secret);
  const queue = new KeyedQueue((key, error) => log.error({ err: error, key }, 'Queued task failed'));
  const enablement = new ModuleEnablement(database.admin);
  const runtimes = createModuleRuntimes(modules, { client, database, log });
  // Resolves once the start hooks finished (or the bot stopped); guild work waits for it.
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  // Gateway events and interactions run only once their guild is set up, so module switches are loaded.
  const guildGate = async (guildId: string): Promise<boolean> => {
    await started;
    if (stopped) return false;
    try {
      await lifecycle.ready(guildId);
      return true;
    } catch (error) {
      log.error({ err: error }, `Setting up guild ${guildId} failed`);
      return false;
    }
  };
  const dispatcher = new Dispatcher({ runtimes, database, enablement, queue, guildGate, signer, now: options.now });
  const modulesCommand = createModulesCommand({
    runtimes,
    enablement,
    setModuleEnabled: (guildId, module, enabled, actorId, check) =>
      lifecycle.setModuleEnabled(guildId, module, enabled, actorId, check),
  });
  const router = new InteractionRouter({
    sources: [
      { runtime: createCoreRuntime({ client, database, log }), commands: { modules: modulesCommand }, components: [], alwaysEnabled: true },
      ...runtimes.map((runtime) => ({
        runtime,
        commands: runtime.loaded.definition.commands ?? {},
        components: runtime.loaded.definition.components ?? [],
      })),
    ],
    dispatcher,
    enablement,
    guildGate,
    log,
    deferAfterMs: options.deferAfterMs,
    signer,
    now: options.now,
  });
  const commands = new CommandSync({
    registry: restCommandRegistry(client),
    desired: (guildId) => router.commandsFor(guildId).map(([name, command]) => commandToJson(name, command)),
    log,
  });
  const lifecycle = new GuildLifecycle({
    runtimes,
    dispatcher,
    enablement,
    database,
    commands,
    // Optional chaining on members too: test clients cache plain guild objects.
    botPermissions: (guildId) => client.guilds.cache.get(guildId)?.members?.me?.permissions ?? null,
  });
  const pending = new Set<Promise<void>>();
  const listeners: Array<[string, (...args: any[]) => void]> = [];
  let prepared = false;
  let attached = false;
  let stopped = false;
  let purgeTimer: NodeJS.Timeout | undefined;

  // An idle pool client that errors (e.g. Postgres restarting) would otherwise crash the process.
  database.adminPool.on('error', (error) => log.error({ err: error }, 'Idle admin database connection failed'));
  database.appPool.on('error', (error) => log.error({ err: error }, 'Idle app database connection failed'));

  function track(work: Promise<unknown>, failure: string): void {
    const tracked = work.then(
      () => undefined,
      (error: unknown) => {
        log.error({ err: error }, failure);
      },
    );
    pending.add(tracked);
    void tracked.then(() => pending.delete(tracked));
  }

  async function prepare(): Promise<void> {
    if (prepared) return;
    const schemaProblems = await prepareDatabase(database, {
      modules: migrationTargets(modules),
      expectations: schemaExpectations(modules),
    });
    const problems = [
      ...(schemaProblems.length > 0 ? formatSchemaProblems(schemaProblems).split('\n') : []),
      ...(await checkRoles(
        database,
        modules.filter((module) => module.definition.db !== undefined).map((module) => module.definition.name),
      )),
    ];
    if (problems.length > 0) throw new StartupError(problems);
    const loaded = new Set(['core', ...modules.map((module) => module.definition.name)]);
    for (const name of await listMigratedModules(database)) {
      if (!loaded.has(name)) {
        log.warn({ module: name }, 'Keeping the schema of a module that is not loaded; remove it with `bronto purge`');
      }
    }
    prepared = true;
  }

  function setUp(guildId: string, joined: boolean): void {
    track(
      started.then(() => (stopped ? undefined : lifecycle.setUp(guildId, joined))),
      `Setting up guild ${guildId} failed`,
    );
  }

  // A purge that outlasts the interval must not overlap the next one: both would see the same due guilds
  // and run every module's cleanup hooks twice.
  let purging = false;

  function runPurge(): void {
    if (purging) return;
    purging = true;
    track(
      lifecycle
        .purgeDueGuilds()
        .then((deleted) => {
          if (deleted.length > 0) log.info({ guilds: deleted }, 'Deleted the data of guilds the bot left');
        })
        .finally(() => {
          purging = false;
        }),
      'Purging guild data failed',
    );
  }

  async function onReady(): Promise<void> {
    for (const runtime of runtimes) {
      const start = runtime.loaded.definition.hooks?.start;
      if (start === undefined) continue;
      try {
        await start(runtime.context);
      } catch (error) {
        runtime.context.log.error({ err: error }, 'Start hook failed');
      }
    }
    markStarted();
    if (stopped) return;
    // The cache lists every guild of this (single-shard) client, unavailable ones included; guilds missing from it
    // removed the bot while it was offline.
    track(lifecycle.reconcile([...client.guilds.cache.keys()]), 'Recording guilds the bot left while offline failed');
    for (const guild of client.guilds.cache.values()) {
      if (guild.available) setUp(guild.id, false);
    }
    runPurge();
    purgeTimer = setInterval(runPurge, options.purgeIntervalMs ?? DAY_MS);
    purgeTimer.unref();
  }

  function listen(event: string, listener: (...args: any[]) => void): void {
    listeners.push([event, listener]);
    client.on(event, listener);
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    listen(Events.ClientReady, () => track(onReady(), 'Startup work failed'));
    listen(Events.GuildAvailable, (guild: Guild) => setUp(guild.id, false));
    listen(Events.GuildCreate, (guild: Guild) => setUp(guild.id, true));
    listen(Events.GuildUnavailable, (guild: Guild) => lifecycle.forget(guild.id));
    listen(Events.GuildDelete, (guild: Guild) => track(lifecycle.leave(guild.id), `Leaving guild ${guild.id} failed`));
    listen(Events.InteractionCreate, (interaction: Interaction) =>
      track(router.handle(interaction), 'Handling an interaction failed'),
    );
    for (const event of dispatcher.discordEvents()) {
      listen(event, (...args: unknown[]) => {
        dispatcher.handleDiscord(event, args).catch((error: unknown) => {
          log.error({ err: error }, `Dispatching ${event} failed`);
        });
      });
    }
  }

  function detach(): void {
    for (const [event, listener] of listeners.splice(0)) client.off(event, listener);
  }

  async function idle(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
    await dispatcher.idle();
    await queue.idle();
    await commands.idle();
  }

  return {
    runtimes,
    dispatcher,
    enablement,
    lifecycle,
    router,
    commands,
    prepare,
    async start() {
      await prepare();
      attach();
      await client.login(config.discord.token);
    },
    idle,
    async stop() {
      stopped = true;
      markStarted();
      clearInterval(purgeTimer);
      detach();
      await idle();
      clearInterval(purgeTimer);
      await client.destroy();
    },
  };
}
