import { defineModule, type ModuleDefinition } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { GatewayIntentBits } from 'discord.js';

export type MoveApi = Record<string, never>;

/** A move module with its own in-memory state; the default export is the one deployments load. */
export function createMoveModule(): ModuleDefinition<Record<string, never>, MoveApi> {
  return defineModule<Record<string, never>, MoveApi>({
    name: 'move',
    docs: new URL('../docs/user/', import.meta.url),
    optionalDependsOn: [mediaonly, sticky],
    api: () => ({}),
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildExpressions],
  });
}

export default createMoveModule();
