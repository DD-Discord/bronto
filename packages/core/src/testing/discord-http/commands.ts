import { route } from './router.js';
import { ok } from './responses.js';
import type { DiscordState } from './state.js';

export function commandRoutes(state: DiscordState) {
  const path = '/applications/:applicationId/guilds/:guildId/commands';
  return [
    route('GET', path, request => ok(state.commands.get(request.path) ?? [])),
    route('PUT', path, request => {
      state.commands.set(request.path, request.body);
      return ok(request.body);
    }),
  ];
}
