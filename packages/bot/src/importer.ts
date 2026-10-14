import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleImporter } from '@bronto/core';

/** Resolves module packages from the deployment directory, whose package.json lists them as dependencies. */
export function createImporter(directory: string = process.cwd()): ModuleImporter {
  const require = createRequire(join(directory, 'package.json'));
  return async (packageName) => import(pathToFileURL(require.resolve(packageName)).href);
}
