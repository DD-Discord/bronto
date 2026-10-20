import { route } from './router.js';
import { error, ok } from './responses.js';
import type { DiscordState } from './state.js';

export function channelRoutes(state: DiscordState) {
  return [
    route('GET', '/channels/:channelId', (_request, { channelId }) => {
      const channel = state.channels.get(channelId);
      return channel ? ok(channel) : error(10003);
    }),
  ];
}
