import type { Sticky } from './db/schema.js';

/** What the message listener needs to know about a sticky channel without asking the database. */
export interface StickyEntry {
  guildId: string;
  channelId: string;
  webhookId: string;
  ignoreBots: boolean;
  debounceMs: number;
}

export function entryOf(sticky: Pick<Sticky, 'guildId' | 'channelId' | 'webhookId' | 'ignoreBots' | 'debounceMs'>): StickyEntry {
  return {
    guildId: sticky.guildId,
    channelId: sticky.channelId,
    webhookId: sticky.webhookId,
    ignoreBots: sticky.ignoreBots,
    debounceMs: sticky.debounceMs,
  };
}

/** The sticky channels of every guild the module runs in; messages in other channels never reach the database. */
export class StickyIndex {
  private readonly entries = new Map<string, StickyEntry>();

  get(channelId: string): StickyEntry | undefined {
    return this.entries.get(channelId);
  }

  set(entry: StickyEntry): void {
    this.entries.set(entry.channelId, entry);
  }

  delete(channelId: string): void {
    this.entries.delete(channelId);
  }

  updateWebhook(channelId: string, webhookId: string): void {
    const entry = this.entries.get(channelId);
    if (entry !== undefined) this.entries.set(channelId, { ...entry, webhookId });
  }

  /** Replaces the entries of one guild; returns the ones it removed. */
  replaceGuild(guildId: string, entries: StickyEntry[]): StickyEntry[] {
    const removed = this.dropGuild(guildId);
    for (const entry of entries) this.set(entry);
    return removed;
  }

  /** Removes the entries of one guild and returns them. */
  dropGuild(guildId: string): StickyEntry[] {
    const removed = [...this.entries.values()].filter((entry) => entry.guildId === guildId);
    for (const entry of removed) this.entries.delete(entry.channelId);
    return removed;
  }
}
