import { describe, expect, it } from 'vitest';
import * as core from './index.js';

describe('@bronto/core exports', () => {
  it('exposes the config and db API', () => {
    for (const name of [
      'loadConfig', 'parseConfig', 'ConfigError', 'substituteEnv',
      'createDatabase', 'prepareDatabase', 'migrateAll', 'coreMigrationTarget', 'createScopedDb',
      'guildTable', 'globalTable', 'globalTableNames', 'auditColumns', 'runInScope', 'currentGuildId', 'currentActor',
      'core', 'guilds', 'guildModules',
      'upsertGuild', 'markGuildLeft', 'markMissingGuildsLeft', 'guildExists', 'guildsDueForPurge', 'purgeGuildIfDue', 'deleteGuildRow',
      'checkSchemas', 'checkRoles', 'formatSchemaProblems', 'purgeModuleSchema', 'listMigratedModules',
      'assertModuleName', 'quoteIdent', 'moduleRoleName', 'MIGRATIONS_SCHEMA', 'GUILD_GRACE_DAYS',
    ]) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it('exposes the module runtime', () => {
    for (const name of [
      'defineModule', 'defineEvent', 'eventLabel', 'on', 'coreEvents', 'loadModules', 'createBot', 'StartupError',
      'KeyedQueue', 'ModuleEnablement', 'Dispatcher', 'GuildLifecycle', 'createModuleRuntimes', 'guildIdOf',
      'migrationTargets', 'schemaExpectations', 'isGuildDue',
    ]) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it('keeps connection-level helpers internal', () => {
    for (const name of ['withMigrationLock', 'applyMigrations', 'grantRoles', 'ensureModuleRoles', 'checkSchemasWith']) {
      expect(core, name).not.toHaveProperty(name);
    }
  });

  it('does not load drizzle-kit at runtime', () => {
    expect(core).not.toHaveProperty('defineModuleDrizzleConfig');
  });

  it('exposes the interaction API', () => {
    for (const name of [
      'defineCommand', 'defineSubcommand', 'defineButton', 'defineModal', 'opt', 'UserError', 'isUserError',
      'InteractionRouter', 'CommandSync', 'restCommandRegistry', 'createModulesCommand', 'commandToJson', 'checkCommand', 'Responder',
      'batchLines', 'truncate', 'plainText', 'createCoreRuntime',
      'defineEntity', 'crudSubcommands', 'colorFromId', 'entityAutocomplete',
    ]) {
      expect(core, name).toHaveProperty(name);
    }
  });
});
