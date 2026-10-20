import { ChannelType, type APIChannel } from 'discord.js';
import { route } from './router.js';
import { error, ok } from './responses.js';
import type { DiscordState } from './state.js';

export function userRoutes(state: DiscordState) {
  return [
    route('GET', '/users/:userId', (_request, { userId }) => {
      const user = state.users.get(userId);
      return user ? ok(user) : error(10013);
    }),
    route('POST', '/users/@me/channels', request => {
      const userId = (request.body as { recipient_id: string }).recipient_id;
      if (!state.users.has(userId)) state.addUser(userId);
      const channel = { id: state.newId(), type: ChannelType.DM, recipients: [state.users.get(userId)!] } as APIChannel;
      state.channels.set(channel.id, channel);
      return ok(channel);
    }),
  ];
}
