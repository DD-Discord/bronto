import { Events, GatewayDispatchEvents } from 'discord.js';
import { eq, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { gatewayEvent, on, type Listener } from '../runtime/events.js';
import type { ModuleHooks } from '../runtime/module.js';
import type { HandlerContext } from '../runtime/types.js';
import type { ChannelRule, ChannelRuleIndex } from './channel-rule-index.js';

/** A per-guild table with one rule per channel or thread. */
export type ChannelRuleTable = PgTable & { guildId: PgColumn; channelId: PgColumn };

export interface ChannelRuleStore<TTable extends ChannelRuleTable> {
  table: TTable;
  index: ChannelRuleIndex<InferSelectModel<TTable> & ChannelRule>;
}

async function removeRuleOf<TTable extends ChannelRuleTable>(
  ctx: HandlerContext,
  { table, index }: ChannelRuleStore<TTable>,
  channelId: string,
  onRemoved?: (ctx: HandlerContext, rule: InferSelectModel<TTable>) => unknown,
): Promise<void> {
  const rows = await ctx.db.run(async (tx) => tx.delete(table).where(eq(table.channelId, channelId)).returning());
  const [removed] = rows as unknown as (InferSelectModel<TTable> & ChannelRule)[];
  if (removed === undefined) return;
  index.delete(removed.guildId, removed.channelId);
  await onRemoved?.(ctx, removed);
}

/**
 * Listeners that delete the rule of a deleted channel or thread and drop it from the index. `onRemoved` runs after the
 * rule is gone, e.g. to clean up what it owned.
 */
export function channelRuleListeners<TTable extends ChannelRuleTable>(
  store: ChannelRuleStore<TTable> & { onRemoved?: (ctx: HandlerContext, rule: InferSelectModel<TTable>) => unknown },
): Listener[] {
  return [
    on(Events.ChannelDelete, (ctx, channel) => removeRuleOf(ctx, store, channel.id, store.onRemoved)),
    // Raw packet: discord.js emits ThreadDelete only for cached threads.
    on(gatewayEvent(GatewayDispatchEvents.ThreadDelete), (ctx, data) => removeRuleOf(ctx, store, data.id, store.onRemoved)),
  ];
}

/** Hooks that load the index of a guild when it becomes ready and drop it when it stops; `onStopped` runs after the drop. */
export function channelRuleHooks<TTable extends ChannelRuleTable>(
  store: ChannelRuleStore<TTable> & { onStopped?: (ctx: HandlerContext) => unknown },
): Pick<ModuleHooks<any>, 'guildReady' | 'guildStopped'> {
  return {
    guildReady: async (ctx) => {
      const rows = (await ctx.db.run(async (tx) => tx.select().from(store.table as PgTable))) as unknown as (InferSelectModel<TTable> & ChannelRule)[];
      store.index.replaceGuild(ctx.guildId, rows);
    },
    guildStopped: async (ctx) => {
      store.index.dropGuild(ctx.guildId);
      await store.onStopped?.(ctx);
    },
  };
}
