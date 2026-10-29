import { defineModule, gate, type ModuleDefinition } from '@bronto/core';
import mediaonly, { mediaonlyGates } from '@bronto/mediaonly';
import sticky from '@bronto/sticky';
import { GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { createMoveButtons } from './buttons.js';
import { createMoveCommand } from './command.js';
import { ChannelLocks } from './locks.js';
import { Mover } from './mover.js';
import { PendingMoves } from './pending.js';

export type MoveApi = Record<string, never>;

/** A move module with its own in-memory state; the default export is the one deployments load. */
export function createMoveModule(): ModuleDefinition<Record<string, never>, MoveApi> {
  const pending = new PendingMoves();
  const mover = new Mover({ locks: new ChannelLocks() });
  const buttons = createMoveButtons({ pending, run: (ctx, move) => mover.run(ctx, move) });
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildExpressions],
    commands: { move: createMoveCommand({ pending, buttons }) },
    components: [buttons.confirm, buttons.cancel],
    // Reposts of a running move are kept: their originals are deleted, so removing them would lose the message.
    listeners: [
      gate(mediaonlyGates.removing, (_ctx, { webhookId }) =>
        webhookId !== null && mover.isActiveWebhook(webhookId) ? { deny: 'A moved message' } : undefined,
      ),
    ],
    hooks: {
      guildStopped: (ctx) => pending.clear(ctx.guildId),
    },
  });
}

export default createMoveModule();
