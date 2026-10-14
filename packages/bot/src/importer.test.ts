import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createImporter } from './importer.js';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));

describe('createImporter', () => {
  it('imports packages the deployment directory depends on', async () => {
    const imported = (await createImporter(packageDirectory)('@bronto/core')) as Record<string, unknown>;
    expect(typeof imported.defineModule).toBe('function');
  });

  it('rejects packages the deployment does not have', async () => {
    await expect(createImporter(packageDirectory)('@bronto/does-not-exist')).rejects.toThrow();
  });
});
