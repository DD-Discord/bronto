import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fillPlaceholders, postPlaceholders } from './placeholders.js';

describe('fillPlaceholders', () => {
  it('fills known keys', () => {
    expect(fillPlaceholders('Hi {user.name} in {server.name}, {user.name}!', { 'user.name': 'ann', 'server.name': 'Hub' })).toBe(
      'Hi ann in Hub, ann!',
    );
  });

  it('fills once and leaves unknown keys', () => {
    expect(fillPlaceholders('{a} {b} a { b {c.d}', { a: '{user.name}', 'user.name': 'ann' })).toBe('{user.name} {b} a { b {c.d}');
  });
});

function message(options: { nickname: string | null }): Message {
  const author = { id: '100000000000000001', username: 'ann', displayName: 'Ann Global' };
  return {
    author,
    member: { displayName: options.nickname ?? author.displayName },
    channelId: '100000000000000002',
    guild: { name: 'Hub' },
    url: 'https://discord.com/channels/1/2/3',
  } as unknown as Message;
}

describe('postPlaceholders', () => {
  it('uses the nickname of a member who has one', () => {
    expect(postPlaceholders(message({ nickname: 'Annie' }))).toEqual({
      'user.mention': '<@100000000000000001>',
      'user.name': 'ann',
      'user.display': 'Annie',
      'channel.mention': '<#100000000000000002>',
      'server.name': 'Hub',
      'message.link': 'https://discord.com/channels/1/2/3',
    });
  });

  it('falls back to the global name without a nickname', () => {
    expect(postPlaceholders(message({ nickname: null }))['user.display']).toBe('Ann Global');
  });
});
