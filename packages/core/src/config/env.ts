import { ConfigError } from './errors.js';

type Env = Record<string, string | undefined>;

// `$$` is a literal `$`; `${NAME}` requires NAME to be set; `${NAME:-default}` falls back when NAME is unset or empty.
const PLACEHOLDER = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Replaces environment placeholders in every string of an already-parsed config value. */
export function substituteEnv(value: unknown, env: Env): unknown {
  const problems: string[] = [];
  const result = walk(value, env, [], problems);
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return result;
}

/** Formats a config path like `modules.@bronto/sticky.hooks[0]`. */
export function formatPath(path: string[]): string {
  const text = path.reduce((out, part) => (part.startsWith('[') || out === '' ? out + part : `${out}.${part}`), '');
  return text === '' ? '(root)' : text;
}

function walk(value: unknown, env: Env, path: string[], problems: string[]): unknown {
  if (typeof value === 'string') {
    return substitute(value, env, path, problems);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walk(item, env, [...path, `[${index}]`], problems));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walk(item, env, [...path, key], problems)]),
    );
  }
  return value;
}

function substitute(text: string, env: Env, path: string[], problems: string[]): string {
  return text.replace(PLACEHOLDER, (match, name: string | undefined, fallback: string | undefined) => {
    if (name === undefined) {
      return '$';
    }
    const value = env[name];
    if (fallback !== undefined) {
      return value === undefined || value === '' ? fallback : value;
    }
    if (value === undefined) {
      problems.push(`${formatPath(path)}: ${name} is not set`);
      return match;
    }
    return value;
  });
}
