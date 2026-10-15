import { describe, expect, it } from 'vitest';
import { parseMessageLink, sendableEmbeds } from './message.js';

describe('parseMessageLink', () => {
  it('reads message links of every Discord host', () => {
    const ids = { guildId: '100000000000000001', channelId: '100000000000000020', messageId: '100000000000000021' };
    for (const host of ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com']) {
      expect(parseMessageLink(` https://${host}/channels/100000000000000001/100000000000000020/100000000000000021 `)).toEqual(ids);
    }
  });

  it('refuses anything else', () => {
    expect(parseMessageLink('https://discord.com/channels/100000000000000001/100000000000000020')).toBeNull();
    expect(parseMessageLink('https://example.com/channels/100000000000000001/100000000000000020/100000000000000021')).toBeNull();
    expect(parseMessageLink('100000000000000021')).toBeNull();
  });
});

describe('sendableEmbeds', () => {
  it('keeps what a webhook may send and drops what Discord adds', () => {
    const received = {
      type: 'rich',
      id: '100000000000000030',
      content_scan_version: 2,
      flags: 0,
      title: 'Welcome',
      description: 'Read the pinned messages.',
      color: 3447003,
      thumbnail: { url: 'https://example.com/a.png', proxy_url: 'https://media.example.com/a.png', width: 64, height: 64 },
      fields: [{ name: 'Rule 1', value: 'Be kind', inline: false }, { name: '', value: 'dropped' }],
      footer: { text: 'Staff', proxy_icon_url: 'https://media.example.com/i.png' },
    };
    expect(sendableEmbeds([received])).toEqual([
      {
        title: 'Welcome',
        description: 'Read the pinned messages.',
        color: 3447003,
        thumbnail: { url: 'https://example.com/a.png' },
        fields: [{ name: 'Rule 1', value: 'Be kind', inline: false }],
        footer: { text: 'Staff' },
      },
    ]);
  });

  it('drops embeds with nothing left to show and ignores non-arrays', () => {
    expect(sendableEmbeds([{ type: 'rich', id: '1', color: 5 }])).toEqual([]);
    expect(sendableEmbeds(null)).toEqual([]);
  });
});
