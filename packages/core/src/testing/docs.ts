import { loadDocs } from '../docs/load.js';
import type { ModuleDocs } from '../docs/types.js';

/** Fails with every problem, one per line as `file:line: message`. */
export function checkDocs(folder: URL, module: string): ModuleDocs {
  const { docs, problems } = loadDocs(folder, module);
  if (docs) return docs;
  throw new Error(`Invalid docs for "${module}":\n${problems.map((p) => `${p.file}:${p.line ?? ''}: ${p.message}`).join('\n')}`);
}
