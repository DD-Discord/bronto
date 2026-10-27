import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDITOR_TTL_MS } from '../src/binding.js';
import { editorComponents } from '../src/editor.js';
import { fillComponents } from '../src/fill.js';
import { retryPostButton } from '../src/submit.js';
import { previewComponents } from '../src/buttons.js';
import { tryAgainButton } from '../src/retry.js';
import { settingsModalDefinition } from '../src/settings.js';
import { transferComponents } from '../src/transfer.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('module loading', () => {
  it('loads the module entry point under tsx', () => {
    const entry = JSON.stringify(new URL('../src/index.ts', import.meta.url).href);
    // execFileSync throws on a non-zero exit code.
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${entry})`], { cwd: ROOT, stdio: 'pipe' });
  });

  it('has no import cycles in src', () => {
    const files = readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const text = readFileSync(`${SRC}${file}`, 'utf8');
      const deps = [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+'\.\/([\w-]+)\.js';/gms)].map((match) => `${match[1]}.ts`);
      graph.set(file, deps);
    }
    const visiting: string[] = [];
    const done = new Set<string>();
    const walk = (file: string): string[] | null => {
      if (visiting.includes(file)) return [...visiting.slice(visiting.indexOf(file)), file];
      if (done.has(file)) return null;
      visiting.push(file);
      for (const dep of graph.get(file) ?? []) {
        const cycle = walk(dep);
        if (cycle !== null) return cycle;
      }
      visiting.pop();
      done.add(file);
      return null;
    };
    for (const file of files) expect(walk(file)).toBeNull();
  });
});

describe('component definitions', () => {
  const editor = [...editorComponents, settingsModalDefinition, tryAgainButton];

  it.each(editor.map((definition) => [definition.name, definition] as const))('%s expires with the editor reply and is bound to user and channel', (_name, definition) => {
    expect(definition.expiresAfterMs).toBe(EDITOR_TTL_MS);
    expect(definition.ephemeral).toBe(true);
    expect(definition.bind).toEqual({ user: true, channel: true });
  });

  it.each(previewComponents.map((definition) => [definition.name, definition] as const))('preview button %s is bound to the post and never expires', (_name, definition) => {
    expect(definition.expiresAfterMs).toBeNull();
    expect(definition.ephemeral).toBe(true);
    expect(definition.bind).toEqual({ user: false, channel: true });
  });

  it('binds the import modal to its user and the post, and the delete confirmation to user and post', () => {
    const [importModal, deleteConfirm] = transferComponents;
    expect(importModal!.bind).toEqual({ user: true, channel: true });
    expect(importModal!.ephemeral).toBe(true);
    expect(deleteConfirm!.bind).toEqual({ user: true, channel: true });
    expect(deleteConfirm!.expiresAfterMs).toBe(EDITOR_TTL_MS);
  });

  it.each([...fillComponents, retryPostButton].map((definition) => [definition.name, definition] as const))('filling component %s is bound to its member and never expires', (_name, definition) => {
    expect(definition.expiresAfterMs).toBeNull();
    expect(definition.ephemeral).toBe(true);
    expect(definition.bind).toEqual({ user: true, channel: false });
  });
});
