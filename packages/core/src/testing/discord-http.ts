import type { FakeHttpAnswer } from './rest.js';
import { channelRoutes } from './discord-http/channels.js';
import { commandRoutes } from './discord-http/commands.js';
import { guildRoutes } from './discord-http/guilds.js';
import { messageRoutes } from './discord-http/messages.js';
import { createRouter } from './discord-http/router.js';
import { DiscordState } from './discord-http/state.js';
import { userRoutes } from './discord-http/users.js';
import { webhookRoutes } from './discord-http/webhooks.js';

/** Synthetic resources served over HTTP; production methods never call this fixture service directly. */
export class FakeDiscordHttp extends DiscordState {
  private readonly overrides = new Map<string, FakeHttpAnswer>();
  private readonly dispatch = createRouter([
    ...guildRoutes(this),
    ...userRoutes(this),
    ...channelRoutes(this),
    ...messageRoutes(this),
    ...webhookRoutes(this),
    ...commandRoutes(this),
  ]);

  override(method: string, path: string, answer: FakeHttpAnswer): void {
    this.overrides.set(`${method} ${path}`, answer);
  }

  clearOverride(method: string, path: string): void {
    this.overrides.delete(`${method} ${path}`);
  }

  answer: FakeHttpAnswer = async request => {
    const override = this.overrides.get(`${request.method} ${request.path}`);
    return override ? override(request) : this.dispatch(request);
  };
}
