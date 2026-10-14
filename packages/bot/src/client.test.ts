import { defineModule } from '@bronto/core';
import { GatewayIntentBits, Partials } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createDiscordClient } from './client.js';

describe('createDiscordClient', () => {
  it('asks for Guilds plus every intent and partial the modules declare', async () => {
    const first = defineModule({
      name: 'intents_a',
      intents: [GatewayIntentBits.GuildMessages],
      partials: [Partials.Message],
    });
    const second = defineModule({
      name: 'intents_b',
      intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages],
    });
    const client = createDiscordClient(
      [first, second].map((definition) => ({ packageName: definition.name, definition, config: {} })),
    );
    try {
      expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
      expect(client.options.intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
      expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(true);
      expect(client.options.intents.has(GatewayIntentBits.GuildMembers)).toBe(false);
      expect(client.options.partials).toEqual([Partials.Message]);
    } finally {
      await client.destroy();
    }
  });
});
