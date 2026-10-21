import { route } from './router.js';
import { error, ok } from './responses.js';
import type { DiscordState } from './state.js';

export function guildRoutes(state: DiscordState) {
  return [
    route('GET', '/guilds/:guildId', (_request, { guildId }) => {
      const guild = state.guilds.get(guildId);
      return guild ? ok(guild) : error(10004);
    }),
    route('GET', '/guilds/:guildId/members/:userId', (_request, { guildId, userId }) => {
      if (!state.guilds.has(guildId)) return error(10004);
      const member = state.members.get(`${guildId}:${userId}`);
      return member ? ok(member) : error(10007);
    }),
  ];
}
