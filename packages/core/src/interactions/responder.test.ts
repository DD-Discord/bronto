import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fakeCommand, type FakeInteraction } from '../testing/interactions.js';
import { DONE, Responder, type ResponseTarget } from './responder.js';

const NO_PINGS = { parse: [] };

function responder(ephemeral = false): { fake: FakeInteraction; responder: Responder } {
  const fake = fakeCommand({ command: 'x' });
  return { fake, responder: new Responder(fake as unknown as ResponseTarget, ephemeral) };
}

const kinds = (fake: FakeInteraction) => fake.responses.map((response) => response.kind);

describe('Responder', () => {
  it('answers with a reply, then follow-ups', async () => {
    const { fake, responder: r } = responder();
    await r.send('first');
    await r.send({ content: 'second', ephemeral: true });
    expect(fake.responses).toEqual([
      { kind: 'reply', payload: { content: 'first', allowedMentions: NO_PINGS } },
      { kind: 'followUp', payload: { content: 'second', allowedMentions: NO_PINGS, flags: MessageFlags.Ephemeral } },
    ]);
  });

  it('pings only the users and roles a reply allows', async () => {
    const { fake, responder: r } = responder();
    await r.send({ content: '<@1> <@&2> @everyone', allowedMentions: { users: ['1'], roles: ['2'] } });
    expect(fake.responses[0]!.payload).toEqual({
      content: '<@1> <@&2> @everyone',
      allowedMentions: { parse: [], users: ['1'], roles: ['2'] },
    });
  });

  it('keeps allowed mentions on the answer to a deferred interaction', async () => {
    const { fake, responder: r } = responder();
    await r.defer();
    await r.send({ content: '<@1>', allowedMentions: { users: ['1'] } });
    expect(fake.responses[1]!.payload).toEqual({ content: '<@1>', allowedMentions: { parse: [], users: ['1'] } });
  });

  it('adds reply flags to the ephemeral flag', async () => {
    const { fake, responder: r } = responder(true);
    await r.send({ content: 'quiet', flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications });
    expect(fake.responses[0]!.payload).toMatchObject({
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
    });
  });

  it('drops SuppressNotifications when editing a deferred answer', async () => {
    const { fake, responder: r } = responder();
    await r.defer();
    await r.send({ content: 'x', flags: MessageFlags.SuppressNotifications | MessageFlags.SuppressEmbeds });
    expect(fake.responses[1]!.payload).toMatchObject({ flags: MessageFlags.SuppressEmbeds });
  });

  it('omits flags on an edit when none remain', async () => {
    const { fake, responder: r } = responder();
    await r.defer();
    await r.send({ content: 'x', flags: MessageFlags.SuppressNotifications });
    expect(fake.responses[1]!.payload).not.toHaveProperty('flags');
  });

  it('refuses flags a reply cannot set', async () => {
    const { responder: r } = responder();
    await expect(r.send({ content: 'x', flags: MessageFlags.Ephemeral })).rejects.toThrow('Reply flags');
  });

  it('uses its default visibility', async () => {
    const { fake, responder: r } = responder(true);
    await r.send('private');
    expect(fake.responses[0]!.payload).toMatchObject({ flags: MessageFlags.Ephemeral });
  });

  it('edits a deferred answer before following up', async () => {
    const { fake, responder: r } = responder(true);
    await r.defer();
    await r.defer();
    await r.send('result');
    await r.send('more');
    expect(kinds(fake)).toEqual(['deferReply', 'editReply', 'followUp']);
    expect(fake.responses[0]!.payload).toEqual({ flags: MessageFlags.Ephemeral });
    expect(fake.responses[1]!.payload).toEqual({ content: 'result', allowedMentions: NO_PINGS });
  });

  it('serializes a defer and a reply started together', async () => {
    const { fake, responder: r } = responder();
    await Promise.all([r.defer(), r.send('result')]);
    expect(kinds(fake)).toEqual(['deferReply', 'editReply']);
  });

  it('does not defer once answered', async () => {
    const { fake, responder: r } = responder();
    await r.send('done');
    await r.defer();
    expect(kinds(fake)).toEqual(['reply']);
  });

  it('reports failures privately in every state', async () => {
    const open = responder();
    await open.responder.fail('nope');
    expect(open.fake.responses).toEqual([
      { kind: 'reply', payload: { content: 'nope', allowedMentions: NO_PINGS, flags: MessageFlags.Ephemeral } },
    ]);

    const deferredPrivately = responder(true);
    await deferredPrivately.responder.defer();
    await deferredPrivately.responder.fail('nope');
    expect(kinds(deferredPrivately.fake)).toEqual(['deferReply', 'editReply']);

    // Discord keeps the defer's visibility on its edit and on the first follow-up, so the public placeholder goes.
    const deferredPublicly = responder();
    await deferredPublicly.responder.defer();
    await deferredPublicly.responder.fail('nope');
    expect(deferredPublicly.fake.responses.slice(1)).toEqual([
      { kind: 'deleteReply', payload: undefined },
      { kind: 'followUp', payload: { content: 'nope', allowedMentions: NO_PINGS, flags: MessageFlags.Ephemeral } },
    ]);

    const answered = responder();
    await answered.responder.send('partial');
    await answered.responder.fail('nope');
    expect(answered.fake.responses[1]).toEqual({
      kind: 'followUp',
      payload: { content: 'nope', allowedMentions: NO_PINGS, flags: MessageFlags.Ephemeral },
    });
  });

  it('update as first answer calls update', async () => {
    const { fake, responder: r } = responder();
    await r.update({ content: 'new', flags: MessageFlags.SuppressNotifications | MessageFlags.SuppressEmbeds });
    expect(fake.responses).toEqual([
      { kind: 'update', payload: { content: 'new', allowedMentions: NO_PINGS, flags: MessageFlags.SuppressEmbeds } },
    ]);
    await r.send('more');
    expect(kinds(fake)).toEqual(['update', 'followUp']);
  });

  it('update after deferUpdate edits the reply', async () => {
    const { fake, responder: r } = responder();
    await r.deferUpdate();
    await r.deferUpdate();
    await r.update('new');
    expect(fake.responses).toEqual([
      { kind: 'deferUpdate', payload: undefined },
      { kind: 'editReply', payload: { content: 'new', allowedMentions: NO_PINGS } },
    ]);
  });

  it('update after reply throws', async () => {
    const { responder: r } = responder();
    await r.send('hi');
    await expect(r.update('new')).rejects.toThrow('update must be the first answer or follow deferUpdate.');
    const deferred = responder();
    await deferred.responder.defer();
    await expect(deferred.responder.update('new')).rejects.toThrow('update must be the first answer');
  });

  it('edits the message again on a second update', async () => {
    const { fake, responder: r } = responder();
    await r.update('a');
    await r.update('b');
    expect(kinds(fake)).toEqual(['update', 'editReply']);
    expect(fake.responses[1]!.payload).toEqual({ content: 'b', allowedMentions: NO_PINGS });
  });

  it('edits again after deferUpdate and update', async () => {
    const { fake, responder: r } = responder();
    await r.deferUpdate();
    await r.update('a');
    await r.update('b');
    expect(kinds(fake)).toEqual(['deferUpdate', 'editReply', 'editReply']);
  });

  it('still refuses update after a reply', async () => {
    const { responder: r } = responder();
    await r.send('x');
    await expect(r.update('y')).rejects.toThrow('update must be the first answer or follow deferUpdate.');
  });

  it('does not deferUpdate once answered', async () => {
    const { fake, responder: r } = responder();
    await r.send('hi');
    await r.deferUpdate();
    expect(kinds(fake)).toEqual(['reply']);
  });

  it('fail after deferUpdate follows up ephemerally', async () => {
    const { fake, responder: r } = responder();
    await r.deferUpdate();
    await r.fail('nope');
    expect(fake.responses.slice(1)).toEqual([
      { kind: 'followUp', payload: { content: 'nope', allowedMentions: NO_PINGS, flags: MessageFlags.Ephemeral } },
    ]);
  });

  it('finish after deferUpdate sends nothing', async () => {
    const { fake, responder: r } = responder();
    await r.deferUpdate();
    await r.finish();
    expect(kinds(fake)).toEqual(['deferUpdate']);
  });

  it('finishes unanswered interactions with Done', async () => {
    const open = responder();
    await open.responder.finish();
    expect(open.fake.responses[0]).toEqual({
      kind: 'reply',
      payload: { content: DONE, allowedMentions: NO_PINGS, flags: MessageFlags.Ephemeral },
    });

    const deferredPrivately = responder(true);
    await deferredPrivately.responder.defer();
    await deferredPrivately.responder.finish();
    expect(kinds(deferredPrivately.fake)).toEqual(['deferReply', 'editReply']);

    const deferredPublicly = responder();
    await deferredPublicly.responder.defer();
    await deferredPublicly.responder.finish();
    expect(kinds(deferredPublicly.fake)).toEqual(['deferReply', 'deleteReply', 'followUp']);

    const answered = responder();
    await answered.responder.send('x');
    await answered.responder.finish();
    expect(kinds(answered.fake)).toEqual(['reply']);
  });

  it('shows a modal only as the first answer', async () => {
    const first = responder();
    await first.responder.showModal({ custom_id: 'a:b', title: 'T', components: [] });
    expect(kinds(first.fake)).toEqual(['showModal']);
    await first.responder.finish();
    expect(kinds(first.fake)).toEqual(['showModal']);

    const late = responder();
    await late.responder.send('x');
    await expect(late.responder.showModal({ custom_id: 'a:b', title: 'T', components: [] })).rejects.toThrow(
      'only be the first answer',
    );
  });

  it('keeps working after a rejected call', async () => {
    const fake = fakeCommand({ command: 'x', rejectResponses: true });
    const r = new Responder(fake as unknown as ResponseTarget, false);
    await expect(r.send('x')).rejects.toThrow('Unknown interaction');
    await expect(r.fail('y')).rejects.toThrow('Unknown interaction');
  });
});
