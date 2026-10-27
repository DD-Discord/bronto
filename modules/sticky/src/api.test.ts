import { describe, expect, it } from 'vitest';
import { stickyApi } from './api.js';
import type { Reposter, StickyContext } from './repost.js';
import { StickyIndex } from './sticky-index.js';

const entry = (guildId: string, channelId: string, webhookId: string) => ({ guildId, channelId, webhookId, ignoreBots: true, debounceMs: 0 });

function setup() {
  const index = new StickyIndex();
  index.set(entry('g1', 'c1', 'w1'));
  index.set(entry('g2', 'c2', 'w2'));
  const api = stickyApi({ guildId: 'g1' } as StickyContext, { index, reposter: {} as Reposter });
  return { index, api };
}

describe('isSticky', () => {
  it('is true for the sticky\'s webhook', () => {
    expect(setup().api.isSticky({ channelId: 'c1', webhookId: 'w1' })).toBe(true);
  });

  it('is false for another webhook in the channel', () => {
    const { api } = setup();
    expect(api.isSticky({ channelId: 'c1', webhookId: 'other' })).toBe(false);
    expect(api.isSticky({ channelId: 'c1', webhookId: null })).toBe(false);
  });

  it('is false for a channel without a sticky', () => {
    expect(setup().api.isSticky({ channelId: 'c9', webhookId: 'w1' })).toBe(false);
  });

  it('is false for another guild\'s sticky', () => {
    expect(setup().api.isSticky({ channelId: 'c2', webhookId: 'w2' })).toBe(false);
  });

  it('follows a replaced webhook', () => {
    const { index, api } = setup();
    index.updateWebhook('c1', 'w1b');
    expect(api.isSticky({ channelId: 'c1', webhookId: 'w1' })).toBe(false);
    expect(api.isSticky({ channelId: 'c1', webhookId: 'w1b' })).toBe(true);
  });
});
