import type { StickyContext, Reposter } from './repost.js';
import type { StickyIndex } from './sticky-index.js';

export interface StickyApi {
  /** Whether the channel or thread has a sticky in this server. */
  exists(channelId: string): Promise<boolean>;
  /** Re-renders the sticky's live post in place (template and collected rows); no-op without a sticky. */
  refresh(channelId: string): Promise<void>;
}

/** The API other modules get; each call runs in the calling handler's server. */
export function stickyApi(ctx: StickyContext, { index, reposter }: { index: StickyIndex; reposter: Reposter }): StickyApi {
  const own = (channelId: string) => index.get(channelId)?.guildId === ctx.guildId;
  return {
    exists: async (channelId) => own(channelId),
    refresh: async (channelId) => {
      if (!own(channelId)) return;
      await ctx.queue.run(channelId, (task) => reposter.refreshPost(task, channelId));
    },
  };
}
