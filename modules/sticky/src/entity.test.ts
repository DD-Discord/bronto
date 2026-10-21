import type { HandlerContext } from '@bronto/core';
import { describe, expect, it } from 'vitest';
import type { Sticky } from './db/schema.js';
import { stickyEntity, templateField } from './entity.js';

const sticky: Sticky = {
  guildId: '100000000000000001',
  channelId: '100000000000000010',
  parentChannelId: null,
  webhookId: '100000000000000040',
  webhookToken: 'fake-token-never-shown',
  templateId: '7d0c3a52-58b4-4c43-9a43-2d4f3c1e0b6a',
  templateChannelId: null,
  templateMessageId: null,
  content: null,
  embeds: null,
  ignoreBots: true,
  silent: false,
  debounceMs: 5000,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  updatedBy: null,
};

const RULES = { id: sticky.templateId, name: 'Rules', url: 'https://discord.com/channels/100000000000000001/100000000000000030' };

/** A context whose templates API knows only RULES. */
const ctx = {
  modules: { get: () => ({ get: async (id: string) => (id === RULES.id ? RULES : null) }) },
} as unknown as HandlerContext;

describe('stickyEntity', () => {
  it('shows a sticky with its template and without its webhook', async () => {
    expect(stickyEntity.formatShort(sticky)).toBe('<#100000000000000010>');
    const json = (await stickyEntity.formatFull(sticky, ctx)).toJSON();
    expect(json.fields).toEqual([
      { name: 'Template', value: `[Rules](${RULES.url})` },
      { name: 'Ignore bots', value: 'Yes', inline: true },
      { name: 'Silent', value: 'No', inline: true },
      { name: 'Debounce', value: '5s', inline: true },
    ]);
    expect(JSON.stringify(json)).not.toContain('fake-token');
    expect(JSON.stringify(json)).not.toContain(sticky.webhookId);
  });

  it('describes no debounce and a missing template', async () => {
    const json = (await stickyEntity.formatFull({ ...sticky, templateId: 'gone', debounceMs: 0 }, ctx)).toJSON();
    expect(json.fields).toContainEqual({ name: 'Template', value: 'Missing (`gone`)' });
    expect(json.fields).toContainEqual({ name: 'Debounce', value: 'Off', inline: true });
  });

  it('names the template with a link to its post, or says it is missing', () => {
    expect(templateField(sticky, { name: 'Rules', url: 'https://discord.com/channels/100000000000000001/100000000000000030' })).toBe(
      '[Rules](https://discord.com/channels/100000000000000001/100000000000000030)',
    );
    expect(templateField(sticky, { name: 'Rules [old] (v2)', url: 'https://discord.com/channels/1/2' })).toBe(
      '[Rules \\[old\\] \\(v2\\)](https://discord.com/channels/1/2)',
    );
    expect(templateField(sticky, null)).toBe('Missing (`7d0c3a52-58b4-4c43-9a43-2d4f3c1e0b6a`)');
  });
});
