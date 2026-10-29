import { defineModule, type ModuleDefinition } from '@bronto/core';
import mediaonly from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createMoveButtons, type RunMove } from './buttons.js';
import { createMoveCommand } from './command.js';
import { PendingMoves } from './pending.js';

export type MoveApi = Record<string, never>;

// Replaced by the mover once it exists.
const run: RunMove = async () => {};

/** A move module with its own in-memory state; the default export is the one deployments load. */
export function createMoveModule(): ModuleDefinition<Record<string, never>, MoveApi> {
  const pending = new PendingMoves();
  const buttons = createMoveButtons({ pending, run });
  return defineModule<Record<string, never>, MoveApi>({
    name: 'move',
    docs: new URL('../docs/user/', import.meta.url),
    optionalDependsOn: [mediaonly, sticky],
    api: () => ({}),
    botPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageWebhooks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.AddReactions,
      PermissionFlagsBits.UseExternalEmojis,
    ],
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildExpressions],
    commands: { move: createMoveCommand({ pending, buttons }) },
    components: [buttons.confirm, buttons.cancel],
    hooks: {
      guildStopped: (ctx) => pending.clear(ctx.guildId),
    },
  });
}

export default createMoveModule();
