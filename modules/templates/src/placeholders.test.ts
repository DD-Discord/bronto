import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fillPlaceholders, postPlaceholders, TIMESTAMP_PLACEHOLDERS } from './placeholders.js';

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

// 2026-10-27T23:30:00Z: late on the 27th in UTC, already the 28th east of it.
const POSTED_AT = Date.UTC(2026, 9, 27, 23, 30);
const UNIX = POSTED_AT / 1000;

function message(options: { nickname: string | null; channel?: object }): Message {
  const author = { id: '100000000000000001', username: 'ann', displayName: 'Ann Global' };
  return {
    author,
    member: { displayName: options.nickname ?? author.displayName },
    channelId: '100000000000000002',
    channel: options.channel ?? { name: 'selfies' },
    guild: { name: 'Hub' },
    url: 'https://discord.com/channels/1/2/3',
    createdTimestamp: POSTED_AT,
  } as unknown as Message;
}

describe('postPlaceholders', () => {
  it('uses the nickname of a member who has one', () => {
    expect(postPlaceholders(message({ nickname: 'Annie' }))).toEqual({
      'user.mention': '<@100000000000000001>',
      'user.name': 'ann',
      'user.display': 'Annie',
      'channel.mention': '<#100000000000000002>',
      'channel.name': 'selfies',
      'server.name': 'Hub',
      'message.link': 'https://discord.com/channels/1/2/3',
      date: `<t:${UNIX}:D>`,
      'date.short': `<t:${UNIX}:d>`,
      time: `<t:${UNIX}:t>`,
      datetime: `<t:${UNIX}:f>`,
      'date.relative': `<t:${UNIX}:R>`,
      'date.iso': '2026-10-27',
    });
  });

  it('leaves the channel name empty for a channel without one', () => {
    expect(postPlaceholders(message({ nickname: null, channel: {} }))['channel.name']).toBe('');
  });

  it('lists the timestamp placeholders, which only render in message text', () => {
    expect(TIMESTAMP_PLACEHOLDERS).toEqual(['date', 'date.short', 'time', 'datetime', 'date.relative']);
  });

  it('falls back to the global name without a nickname', () => {
    expect(postPlaceholders(message({ nickname: null }))['user.display']).toBe('Ann Global');
  });
});
