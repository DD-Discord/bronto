import { describe, expect, it } from 'vitest';
import { UnknownMessageError, UnknownWebhookError } from '../src/discord.js';
import { FakeStickyDiscord } from './fake-discord.js';

describe('FakeStickyDiscord', () => {
  it('tracks posts per webhook and channel like Discord', async () => {
    const discord = new FakeStickyDiscord();
    const hook = discord.addWebhook('100000000000000010');
    const target = { ...hook, threadId: null };
    const first = await discord.send(target, { content: 'a', embeds: [] }, { silent: true, username: 'S' });
    expect(discord.liveMessages('100000000000000010')).toEqual([first]);
    await discord.deleteMessage(target, first);
    await expect(discord.deleteMessage(target, first)).rejects.toBeInstanceOf(UnknownMessageError);
    discord.removeWebhook(hook.id);
    await expect(discord.send(target, { content: 'a', embeds: [] }, { silent: true, username: 'S' })).rejects.toBeInstanceOf(
      UnknownWebhookError,
    );
  });

  it('finds thread posts only through their thread', async () => {
    const discord = new FakeStickyDiscord();
    const hook = discord.addWebhook('100000000000000010');
    const thread = '100000000000000011';
    const id = await discord.send({ ...hook, threadId: thread }, { content: 'a', embeds: [] }, { silent: true, username: 'S' });
    await expect(discord.deleteMessage({ ...hook, threadId: null }, id)).rejects.toBeInstanceOf(UnknownMessageError);
    expect(discord.liveMessages(thread)).toEqual([id]);
    await discord.deleteChannelMessage('100000000000000010', id);
    expect(discord.liveMessages(thread)).toEqual([id]);
    await discord.deleteChannelMessage(thread, id);
    expect(discord.liveMessages(thread)).toEqual([]);
  });
});
