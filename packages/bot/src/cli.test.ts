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
  it.each([[[]], [['unknown']], [['purge']], [['delete-guild']], [['start', 'extra']], [['purge', 'a', 'b']], [['start', '--nope']]])(
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
});
