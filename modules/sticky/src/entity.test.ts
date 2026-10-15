import { describe, expect, it } from 'vitest';
import type { Sticky } from './db/schema.js';
import { stickyEntity } from './entity.js';

const sticky: Sticky = {
  guildId: '100000000000000001',
  channelId: '100000000000000010',
  parentChannelId: null,
  webhookId: '100000000000000040',
  webhookToken: 'fake-token-never-shown',
  templateChannelId: '100000000000000020',
  templateMessageId: '100000000000000021',
  content: 'Please read the rules.',
  embeds: [],
  ignoreBots: true,
  silent: false,
  debounceMs: 5000,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  updatedBy: null,
};

describe('stickyEntity', () => {
  it('shows a sticky without its webhook', () => {
    expect(stickyEntity.formatShort(sticky)).toBe('<#100000000000000010>');
    const json = stickyEntity.formatFull(sticky).toJSON();
    expect(json.fields).toEqual([
      { name: 'Template', value: 'https://discord.com/channels/100000000000000001/100000000000000020/100000000000000021' },
      { name: 'Ignore bots', value: 'Yes', inline: true },
      { name: 'Silent', value: 'No', inline: true },
      { name: 'Debounce', value: '5000 ms', inline: true },
      { name: 'Text', value: 'Please read the rules.' },
    ]);
    expect(JSON.stringify(json)).not.toContain('fake-token');
    expect(JSON.stringify(json)).not.toContain(sticky.webhookId);
  });

  it('describes embed-only stickies and no debounce', () => {
    const json = stickyEntity.formatFull({ ...sticky, content: '', debounceMs: 0 }).toJSON();
    expect(json.fields).toContainEqual({ name: 'Debounce', value: 'Off', inline: true });
    expect(json.fields).toContainEqual({ name: 'Text', value: '(embeds only)' });
  });
});
