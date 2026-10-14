import { describe, expect, it } from 'vitest';
import * as core from './index.js';

describe('@bronto/core exports', () => {
  it('exposes the config and db API', () => {
    for (const name of [
      'loadConfig', 'parseConfig', 'ConfigError', 'substituteEnv',
      'createDatabase', 'migrateAll', 'coreMigrationTarget', 'grantAppRole', 'createScopedDb',
      'guildTable', 'globalTable', 'globalTableNames', 'auditColumns', 'runInScope', 'currentGuildId', 'currentActor',
      'core', 'guilds', 'guildModules',
      'upsertGuild', 'markGuildLeft', 'guildsDueForPurge', 'deleteGuildRow',
      'checkSchemas', 'formatSchemaProblems', 'purgeModuleSchema', 'listMigratedModules',
      'assertModuleName', 'quoteIdent', 'MIGRATIONS_SCHEMA', 'GUILD_GRACE_DAYS',
    ]) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it('does not load drizzle-kit at runtime', () => {
    expect(core).not.toHaveProperty('defineModuleDrizzleConfig');
  });
});
