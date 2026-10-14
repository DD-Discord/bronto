import type { LoadedModule } from '@bronto/core';
import { Client, GatewayIntentBits, type Partials } from 'discord.js';

/** A Discord client asking only for what the loaded modules need; Guilds is always on for guild tracking. */
export function createDiscordClient(modules: LoadedModule[]): Client {
  const intents = new Set<GatewayIntentBits>([GatewayIntentBits.Guilds]);
  const partials = new Set<Partials>();
  for (const { definition } of modules) {
    for (const intent of definition.intents ?? []) intents.add(intent);
    for (const partial of definition.partials ?? []) partials.add(partial);
  }
  return new Client({ intents: [...intents], partials: [...partials] });
}
