import { describe, expect, it } from 'vitest';
import { StickyIndex, type StickyEntry } from './sticky-index.js';

const entry = (guildId: string, channelId: string): StickyEntry => ({
  guildId,
  channelId,
  webhookId: `w${channelId}`,
  ignoreBots: true,
  debounceMs: 0,
});

describe('StickyIndex', () => {
  it('replaces and drops the entries of one guild only', () => {
    const index = new StickyIndex();
    index.set(entry('g1', 'c1'));
    index.set(entry('g2', 'c2'));
    expect(index.replaceGuild('g1', [entry('g1', 'c3')])).toEqual([entry('g1', 'c1')]);
    expect(index.get('c1')).toBeUndefined();
    expect(index.get('c3')).toEqual(entry('g1', 'c3'));
    expect(index.dropGuild('g2')).toEqual([entry('g2', 'c2')]);
    expect(index.get('c2')).toBeUndefined();
  });

  it('updates the webhook of an entry', () => {
    const index = new StickyIndex();
    index.set(entry('g1', 'c1'));
    index.updateWebhook('c1', 'new');
    index.updateWebhook('missing', 'new');
    expect(index.get('c1')?.webhookId).toBe('new');
    expect(index.get('missing')).toBeUndefined();
  });
});
