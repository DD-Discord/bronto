import { execFile } from 'node:child_process';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { main, USAGE, type CliIo } from './cli.js';
import type { CommandDeps } from './commands.js';

function io(): CliIo & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    deps: {} as CommandDeps,
    write: (text) => {
      output.push(text);
    },
    onShutdown: vi.fn(),
  };
}

describe('main', () => {
  it.each([[[]], [['unknown']], [['purge']], [['delete-guild']], [['start', 'extra']], [['purge', 'a', 'b']], [['import-legacy', 'widgets']], [['import-legacy', 'widgets', 'a', 'b']], [['purge', 'widgets', '--dry-run']], [['start', '--nope']]])(
    'prints the usage for %j',
    async (argv) => {
      const cli = io();
      expect(await main(argv, cli)).toBe(2);
      expect(cli.output.join('')).toContain(USAGE);
    },
  );

  it('reports a missing config file', async () => {
    const cli = io();
    expect(await main(['purge', 'widgets', '--config', '/does/not/exist.yaml'], cli)).toBe(1);
    expect(cli.output.join('')).toContain('Config file not found: /does/not/exist.yaml');
  });

  it('runs when started through a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bronto-bin-'));
    const link = join(dir, 'bronto.ts');
    await symlink(fileURLToPath(new URL('./cli.ts', import.meta.url)), link);
    const run = promisify(execFile)(process.execPath, ['--import', 'tsx', link], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    });
    const failure = (await run.then(
      () => null,
      (error: unknown) => error,
    )) as { code?: number; stderr?: string } | null;
    expect(failure?.code).toBe(2);
    expect(failure?.stderr).toContain(USAGE);
  });
});
