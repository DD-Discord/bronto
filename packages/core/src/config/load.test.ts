import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.js';
import { loadConfig, parseConfig } from './load.js';

const YAML = `
discord:
  token: \${DISCORD_TOKEN}
database:
  appUrl: \${DATABASE_APP_URL}
  adminUrl: postgres://admin:pw@db:5432/bronto
modules:
  "@bronto/sticky":
    webhookName: Sticky
  "@bronto/other":
`;

const ENV = { DISCORD_TOKEN: 'token-1', DATABASE_APP_URL: 'postgres://bot_app:pw@db:5432/bronto' };

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('parseConfig', () => {
  it('parses, substitutes and validates a full config', () => {
    expect(parseConfig(YAML, ENV)).toEqual({
      discord: { token: 'token-1' },
      database: { appUrl: 'postgres://bot_app:pw@db:5432/bronto', adminUrl: 'postgres://admin:pw@db:5432/bronto' },
      modules: { '@bronto/sticky': { webhookName: 'Sticky' }, '@bronto/other': {} },
      interactions: {},
    });
  });

  it('reads an interaction secret of at least 32 characters', () => {
    const text = `${YAML}interactions:\n  secret: \${INTERACTION_SECRET}\n`;
    const secret = 'x'.repeat(32);
    expect(parseConfig(text, { ...ENV, INTERACTION_SECRET: secret }).interactions).toEqual({ secret });
    expect(problemsOf(() => parseConfig(text, { ...ENV, INTERACTION_SECRET: 'short' }))).toEqual([
      'interactions.secret: must be at least 32 characters',
    ]);
  });

  it('keeps secrets with YAML syntax verbatim', () => {
    const token = 'a: b # c\n- d "e"';
    expect(parseConfig(YAML, { ...ENV, DISCORD_TOKEN: token }).discord.token).toBe(token);
  });

  it('defaults to no modules', () => {
    const text = YAML.slice(0, YAML.indexOf('modules:'));
    expect(parseConfig(text, ENV).modules).toEqual({});
  });

  it('rejects an empty required value with its path', () => {
    const problems = problemsOf(() => parseConfig(YAML, { ...ENV, DISCORD_TOKEN: '' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^discord\.token: /);
  });

  it('rejects database URLs that are not postgres URLs', () => {
    const problems = problemsOf(() => parseConfig(YAML, { ...ENV, DATABASE_APP_URL: 'mysql://x' }));
    expect(problems).toEqual(['database.appUrl: must be a postgres:// URL']);
  });

  it('reports unset variables before validation', () => {
    expect(problemsOf(() => parseConfig(YAML, {}))).toEqual([
      'discord.token: DISCORD_TOKEN is not set',
      'database.appUrl: DATABASE_APP_URL is not set',
    ]);
  });

  it('rejects unknown keys with their path', () => {
    expect(problemsOf(() => parseConfig(`${YAML}\nmodule: {}\n`, ENV))).toEqual(['(root): Unrecognized key: "module"']);
    const typo = YAML.replace('adminUrl:', 'adminUrl: postgres://a@b/c\n  admnUrl:');
    expect(problemsOf(() => parseConfig(typo, ENV))).toEqual(['database: Unrecognized key: "admnUrl"']);
  });

  it('reports invalid YAML', () => {
    const problems = problemsOf(() => parseConfig('discord: [unclosed', ENV));
    expect(problems[0]).toMatch(/^YAML: /);
  });
});

describe('loadConfig', () => {
  it('reads the config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bronto-config-'));
    const path = join(dir, 'config.yaml');
    await writeFile(path, YAML);
    expect((await loadConfig(path, ENV)).discord.token).toBe('token-1');
  });
});
