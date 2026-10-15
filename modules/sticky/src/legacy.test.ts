import { describe, expect, it } from 'vitest';
import { parseLegacySticky, reviveLegacyDates } from './legacy.js';

describe('reviveLegacyDates', () => {
  it('turns the old date encoding into dates', () => {
    const parsed = JSON.parse('{"createdAt":{"$date":"2024-01-02T03:04:05.000Z"},"other":{"$date":"x","y":1}}', reviveLegacyDates);
    expect(parsed.createdAt).toEqual(new Date('2024-01-02T03:04:05.000Z'));
    expect(parsed.other).toEqual({ $date: 'x', y: 1 });
  });
});

describe('parseLegacySticky', () => {
  it('reads the flat record shape', () => {
    expect(
      parseLegacySticky({
        channelId: '100000000000000110',
        templateId: '100000000000000111',
        webhookId: '100000000000000112',
        lastMessageId: '100000000000000113',
        creatorId: '100000000000000099',
        content: 'Hello',
        embeds: [],
        ignoreBots: false,
        silent: true,
      }),
    ).toEqual({
      channelId: '100000000000000110',
      guildId: null,
      templateChannelId: '100000000000000110',
      templateMessageId: '100000000000000111',
      content: 'Hello',
      embeds: [],
      ignoreBots: false,
      silent: true,
      debounceMs: 0,
      lastMessageId: '100000000000000113',
      webhookId: '100000000000000112',
      webhookToken: null,
      creatorId: '100000000000000099',
      repostPending: false,
    });
  });

  it('reads the nested record shape with a webhook URL', () => {
    const parsed = parseLegacySticky({
      guildId: '100000000000000001',
      channelId: '100000000000000120',
      channel: { id: '100000000000000120', name: 'general', parent: { id: '100000000000000121', name: 'chat' } },
      template: { id: '100000000000000122', channel: { id: '100000000000000123', name: 'templates' } },
      webhookId: '100000000000000124',
      webhookUrl: 'https://discord.com/api/webhooks/100000000000000124/fake-token-abc',
      content: '',
      embeds: [{ type: 'rich', id: '1', title: 'Welcome', content_scan_version: 2 }],
      debounce: 999_999_999,
      isDebouncing: true,
      lastMessage: { id: '100000000000000125', channel: { id: '100000000000000120' } },
      lastMessageId: '100000000000000126',
    });
    expect(parsed).toMatchObject({
      channelId: '100000000000000120',
      guildId: '100000000000000001',
      templateChannelId: '100000000000000123',
      templateMessageId: '100000000000000122',
      embeds: [{ title: 'Welcome' }],
      debounceMs: 86_400_000,
      lastMessageId: '100000000000000125',
      webhookId: '100000000000000124',
      webhookToken: 'fake-token-abc',
      repostPending: true,
    });
  });

  it('names what is missing', () => {
    expect(parseLegacySticky('nope')).toEqual({ skip: 'not a sticky record' });
    expect(parseLegacySticky({ templateId: '1', webhookId: '2' })).toEqual({ skip: 'no channel' });
    expect(parseLegacySticky({ channelId: '1', webhookId: '2' })).toEqual({ skip: 'no template' });
    expect(parseLegacySticky({ channelId: '1', templateId: '2' })).toEqual({ skip: 'no webhook' });
  });
});
