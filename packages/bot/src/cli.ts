import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, StartupError } from '@bronto/core';
import { pino } from 'pino';
import { createDiscordClient } from './client.js';
import { CliError, runDeleteGuild, runPurge, runStart, type CommandDeps } from './commands.js';
import { createImporter } from './importer.js';

export const USAGE = `Usage: bronto <command> [--config <path>]

Commands:
  start               Run the bot
  purge <module>      Drop a module's schema and migration history
  delete-guild <id>   Delete all data of one guild now

Options:
  -c, --config <path>  Deployment config file (default: config.yaml)`;

/** Number of arguments each command takes after its name. */
const ARGUMENTS: Record<string, number> = { start: 0, purge: 1, 'delete-guild': 1 };

export interface CliIo {
  deps: CommandDeps;
  write(text: string): void;
  /** Registers how to stop a started bot when the process is asked to exit. */
  onShutdown(stop: () => Promise<void>): void;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: { config: { type: 'string', short: 'c', default: 'config.yaml' } },
  });
}

/** Runs one command and returns the exit code; after `start` the bot keeps running until shutdown. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const [command, argument, ...rest] = parsed.positionals;
  const expected = command === undefined ? undefined : ARGUMENTS[command];
  if (expected === undefined || rest.length > 0 || (expected === 1) !== (argument !== undefined)) {
    io.write(`${USAGE}\n`);
    return 2;
  }
  const configPath = parsed.values.config;
  try {
    if (command === 'start') {
      const running = await runStart(configPath, io.deps);
      io.onShutdown(running.stop);
    } else if (command === 'purge') {
      await runPurge(configPath, argument!, io.deps);
    } else {
      await runDeleteGuild(configPath, argument!, io.deps);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StartupError || error instanceof CliError) {
      io.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

// Node runs the resolved file, so compare against the real path of argv[1] (it may be a symlink, e.g. a bin link).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  // A local .env is convenient in development; variables already set (compose, CI) are never overridden.
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const io: CliIo = {
    deps: { importer: createImporter(), env: process.env, log, createClient: createDiscordClient },
    write: (text) => {
      process.stderr.write(text);
    },
    onShutdown: (stop) => {
      const shutdown = () => {
        stop().then(
          () => process.exit(0),
          (error: unknown) => {
            log.error({ err: error }, 'Shutdown failed');
            process.exit(1);
          },
        );
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
  };
  main(process.argv.slice(2), io).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error: unknown) => {
      log.error({ err: error }, 'Command failed');
      process.exitCode = 1;
    },
  );
}
