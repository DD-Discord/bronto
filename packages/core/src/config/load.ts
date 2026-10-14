import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { formatPath, substituteEnv } from './env.js';
import { ConfigError } from './errors.js';
import { coreConfigSchema, type CoreConfig } from './schema.js';

type Env = Record<string, string | undefined>;

/** Reads and validates the deployment config file. */
export async function loadConfig(path: string, env: Env = process.env): Promise<CoreConfig> {
  return parseConfig(await readFile(path, 'utf8'), env);
}

/** Parses YAML first and substitutes environment values afterwards, so values can never change the structure. */
export function parseConfig(text: string, env: Env): CoreConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ConfigError([`YAML: ${(error as Error).message}`]);
  }
  const result = coreConfigSchema.safeParse(substituteEnv(raw ?? {}, env));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${formatPath(issue.path.map(String))}: ${issue.message}`),
    );
  }
  return result.data;
}
