import { Events, type Client, type Guild } from 'discord.js';
import type { Logger } from 'pino';
import type { CoreConfig } from '../config/schema.js';
import { checkRoles, formatSchemaProblems } from '../db/checks.js';
import type { Database } from '../db/database.js';
import { prepareDatabase } from '../db/prepare.js';
import { listMigratedModules } from '../db/purge.js';
import { createModuleRuntimes, type ModuleRuntime } from './context.js';
import { Dispatcher } from './dispatcher.js';
import { ModuleEnablement } from './enablement.js';
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
}

export interface Bot {
  readonly runtimes: ModuleRuntime[];
  readonly dispatcher: Dispatcher;
  readonly enablement: ModuleEnablement;
  readonly lifecycle: GuildLifecycle;
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
  const { config, modules, database, client, log } = options;
  const queue = new KeyedQueue((key, error) => log.error({ err: error, key }, 'Queued task failed'));
  const enablement = new ModuleEnablement(database.admin);
  const runtimes = createModuleRuntimes(modules, { client, database, log });
  // Resolves once the start hooks finished (or the bot stopped); guild work waits for it.
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const dispatcher = new Dispatcher({
    runtimes,
    database,
    enablement,
    queue,
    // Gateway events run only once their guild is set up, so module switches are loaded.
    guildGate: async (guildId) => {
      await started;
      if (stopped) return false;
      try {
        await lifecycle.ready(guildId);
        return true;
      } catch (error) {
        log.error({ err: error }, `Setting up guild ${guildId} failed`);
        return false;
      }
    },
  });
  const lifecycle = new GuildLifecycle({ runtimes, dispatcher, enablement, database });
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
      ...(await checkRoles(database)),
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

  function runPurge(): void {
    track(
      lifecycle.purgeDueGuilds().then((deleted) => {
        if (deleted.length > 0) log.info({ guilds: deleted }, 'Deleted the data of guilds the bot left');
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
  }

  return {
    runtimes,
    dispatcher,
    enablement,
    lifecycle,
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
