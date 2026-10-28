import { FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType, type APIEmbed } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import type { TemplatesContext } from '../src/context.js';
import { templateImages, templates, type ImageSlot } from '../src/db/schema.js';
import { linkExpiry } from '@bronto/core';
import { embedLength } from '../src/content.js';
import { render, setSlot } from '../src/render.js';
import { FORUM, GUILD, prepareTemplatesBot, templatesDb, type TemplatesBot } from './harness.js';

const THREAD = '100000000000000100';
const PREVIEW = '100000000000000101';
const HOUR = 3_600_000;

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  tb = await prepareTemplatesBot(t, discord);
  discord.addChannel(THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: FORUM });
});

afterEach(async () => {
  await tb.bot.stop();
  await t.drop();
});

/** Runs `fn` as a templates handler of GUILD. */
async function inHandler<T>(fn: (ctx: TemplatesContext) => Promise<T>): Promise<T> {
  const runtime = tb.bot.runtimes.find((entry) => entry.name === 'templates')!;
  let result: { value: T } | undefined;
  const outcome = await tb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => {
    result = { value: await fn(ctx as TemplatesContext) };
  });
  if (!outcome.ok) throw outcome.error;
  return result!.value;
}

interface Seed {
  embed?: Record<string, unknown> | null;
  showPostTime?: boolean;
  images?: { slot: ImageSlot; filename: string; expiresAt: Date; stale?: boolean }[];
}

/** The seed's embed with each image's slot pointing at its file, as the editor stores uploads. */
function embedWithReferences(options: Seed): APIEmbed | null {
  if (options.embed === undefined || options.embed === null) return null;
  const embed = structuredClone(options.embed) as APIEmbed;
  for (const image of options.images ?? []) setSlot(embed, image.slot, `attachment://${image.filename}`);
  return embed;
}

/** A template whose preview message in THREAD carries the given images; returns its id and the attachment ids. */
async function seed(options: Seed = {}): Promise<{ id: string; attachments: Record<string, string> }> {
  const images = options.images ?? [];
  discord.addMessage(THREAD, PREVIEW, { files: images.map((image) => ({ filename: image.filename, data: 'png' })) });
  const attachments = discord.messages.get(PREVIEW)!.attachments;
  const [row] = await templatesDb(t).run(async (tx) => {
    const [created] = await tx
      .insert(templates)
      .values({
        name: 'welcome',
        content: 'Hello',
        embed: embedWithReferences(options) as never,
        showPostTime: options.showPostTime ?? false,
        threadId: THREAD,
        previewMessageId: PREVIEW,
      })
      .returning();
    if (images.length > 0) {
      await tx.insert(templateImages).values(
        images.map((image, index) => ({
          templateId: created!.id,
          slot: image.slot,
          messageId: PREVIEW,
          attachmentId: attachments[index]!.id,
          url: `https://cdn.discordapp.com/attachments/${THREAD}/${attachments[index]!.id}/${image.filename}?ex=1&is=1&hm=old`,
          expiresAt: image.expiresAt,
        })),
      );
    }
    return [created!];
  });
  return { id: row!.id, attachments: Object.fromEntries(images.map((image, index) => [image.slot, attachments[index]!.id])) };
}

const storedImages = () => t.database.admin.select().from(templateImages);
const gets = () => tb.requests.filter((request) => request.method === 'GET' && request.path.includes(`/channels/${THREAD}`));

describe('render', () => {
  it('returns null for an unknown id', async () => {
    expect(await inHandler((ctx) => render(ctx, '00000000-0000-4000-8000-000000000000'))).toBeNull();
  });

  it('uses the cached link while it is valid', async () => {
    const future = new Date(Date.now() + 5 * HOUR);
    const { id } = await seed({ embed: { title: 'Hi' }, images: [{ slot: 'image', filename: 'a.png', expiresAt: future }] });
    const before = gets().length;
    const message = await inHandler((ctx) => render(ctx, id));
    expect(gets()).toHaveLength(before);
    const [stored] = await storedImages();
    expect(message).toEqual({ content: 'Hello', embed: { title: 'Hi', image: { url: stored!.url } } });
  });

  it('refetches the preview when the link expires within an hour and stores the new link', async () => {
    const soon = new Date(Date.now() + HOUR / 2);
    const { id } = await seed({
      embed: { title: 'Hi', author: { name: 'Me' } },
      images: [
        { slot: 'image', filename: 'a.png', expiresAt: soon },
        { slot: 'author_icon', filename: 'b.png', expiresAt: new Date(Date.now() + 5 * HOUR) },
      ],
    });
    const message = await inHandler((ctx) => render(ctx, id));
    expect(gets().some((request) => request.path.endsWith(`/messages/${PREVIEW}`))).toBe(true);
    const rows = await storedImages();
    const image = rows.find((row) => row.slot === 'image')!;
    expect(image.url).not.toContain('hm=old');
    expect(image.expiresAt.getTime()).toBe(linkExpiry(image.url)!.getTime());
    expect(image.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * HOUR);
    expect(message!.embed!.image).toEqual({ url: image.url });
    // A valid link stays as stored.
    expect(rows.find((row) => row.slot === 'author_icon')!.url).toContain('hm=old');
    expect(message!.embed!.author).toEqual({ name: 'Me', icon_url: rows.find((row) => row.slot === 'author_icon')!.url });
  });

  it('sets every slot, creating the embed parts it needs', async () => {
    const future = new Date(Date.now() + 5 * HOUR);
    const slots: ImageSlot[] = ['image', 'thumbnail', 'author_icon', 'footer_icon'];
    const { id } = await seed({
      embed: { description: 'x', author: { name: 'Me' }, footer: { text: 'Foot' } },
      images: slots.map((slot) => ({ slot, filename: `${slot}.png`, expiresAt: future })),
    });
    const embed = (await inHandler((ctx) => render(ctx, id)))!.embed!;
    expect(embed.image?.url).toContain('image.png');
    expect(embed.thumbnail?.url).toContain('thumbnail.png');
    expect(embed.author?.icon_url).toContain('author_icon.png');
    expect(embed.footer?.icon_url).toContain('footer_icon.png');
  });

  it('omits icons without an author name or footer text and logs a warning', async () => {
    const future = new Date(Date.now() + 5 * HOUR);
    const { id } = await seed({
      embed: { description: 'x' },
      images: [
        { slot: 'author_icon', filename: 'a.png', expiresAt: future },
        { slot: 'footer_icon', filename: 'f.png', expiresAt: future },
      ],
    });
    const message = await inHandler((ctx) => render(ctx, id));
    expect(message!.embed).toEqual({ description: 'x' });
    expect(tb.lines.filter((line) => line.level === 40)).toHaveLength(2);
  });

  it('leaves out a slot whose attachment is gone and logs a warning', async () => {
    const { id, attachments } = await seed({
      embed: { title: 'Hi' },
      images: [{ slot: 'image', filename: 'a.png', expiresAt: new Date(Date.now() - HOUR) }],
    });
    const message = discord.messages.get(PREVIEW)!;
    message.attachments = message.attachments.filter((attachment) => attachment.id !== attachments.image);
    const rendered = await inHandler((ctx) => render(ctx, id));
    expect(rendered!.embed).toEqual({ title: 'Hi' });
    expect(tb.lines.some((line) => line.level === 40)).toBe(true);
  });

  it('leaves out an attachment:// slot without a stored upload and logs a warning', async () => {
    const { id } = await seed({ embed: { title: 'Hi', image: { url: 'attachment://image.png' }, author: { name: 'Me', icon_url: 'attachment://author_icon.png' } } });
    const rendered = await inHandler((ctx) => render(ctx, id));
    expect(rendered!.embed).toEqual({ title: 'Hi', author: { name: 'Me' } });
    expect(tb.lines.filter((line) => line.level === 40)).toHaveLength(2);
  });

  it('leaves out a slot whose stored upload is another file than the embed names', async () => {
    const future = new Date(Date.now() + 5 * HOUR);
    const { id } = await seed({ embed: { title: 'Hi' }, images: [{ slot: 'image', filename: 'image.png', expiresAt: future }] });
    await t.database.admin.update(templates).set({ embed: { title: 'Hi', image: { url: 'attachment://image.jpg' } } });
    const rendered = await inHandler((ctx) => render(ctx, id));
    expect(rendered!.embed).toEqual({ title: 'Hi' });
    expect(tb.lines.some((line) => line.level === 40)).toBe(true);
  });

  it('fills the time of posting', async () => {
    const { id } = await seed({ embed: { title: 'Hi' }, showPostTime: true });
    const before = Date.now();
    const message = await inHandler((ctx) => render(ctx, id));
    const stamp = Date.parse(message!.embed!.timestamp!);
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('adds no time when the template is off or has no embed', async () => {
    const plain = await seed({ embed: { title: 'Hi' } });
    expect((await inHandler((ctx) => render(ctx, plain.id)))!.embed!.timestamp).toBeUndefined();
  });

  describe('placeholders', () => {
    const values = { 'user.name': 'ann', 'server.name': 'Hub' };

    it('fills known keys', async () => {
      const { id } = await seed({});
      await t.database.admin.update(templates).set({ content: 'Hi {user.name}' });
      expect((await inHandler((ctx) => render(ctx, id, values)))!.content).toBe('Hi ann');
    });

    it('fills once and leaves unknown keys', async () => {
      const { id } = await seed({});
      await t.database.admin.update(templates).set({ content: '{a} {b} a { b' });
      const message = await inHandler((ctx) => render(ctx, id, { a: '{user.name}', 'user.name': 'ann' }));
      expect(message!.content).toBe('{user.name} {b} a { b');
    });

    it('fills every embed text field', async () => {
      const { id } = await seed({});
      const text = '{server.name}';
      await t.database.admin.update(templates).set({
        embed: {
          title: text,
          description: text,
          fields: [{ name: text, value: text }],
          footer: { text },
          author: { name: text },
        },
      });
      const embed = (await inHandler((ctx) => render(ctx, id, values)))!.embed!;
      expect(embed).toEqual({
        title: 'Hub',
        description: 'Hub',
        fields: [{ name: 'Hub', value: 'Hub' }],
        footer: { text: 'Hub' },
        author: { name: 'Hub' },
      });
    });

    it("cuts filled text to Discord's limits", async () => {
      const { id } = await seed({});
      const long = { 'user.name': 'x'.repeat(5000) };
      await t.database.admin.update(templates).set({
        content: '{user.name}',
        embed: { title: '{user.name}', fields: [{ name: 'n', value: '{user.name}' }] },
      });
      const message = (await inHandler((ctx) => render(ctx, id, long)))!;
      expect(message.content).toBe(`${'x'.repeat(1999)}…`);
      expect(message.embed!.title).toBe(`${'x'.repeat(255)}…`);
      expect(message.embed!.fields![0]!.value).toBe(`${'x'.repeat(1023)}…`);
    });

    it('cuts the description when the embed exceeds 6000 characters', async () => {
      const { id } = await seed({});
      await t.database.admin.update(templates).set({
        embed: {
          description: '{user.name}',
          fields: Array.from({ length: 4 }, () => ({ name: 'n', value: '{user.name}' })),
        },
      });
      const embed = (await inHandler((ctx) => render(ctx, id, { 'user.name': 'x'.repeat(5000) })))!.embed!;
      expect(embedLength(embed)).toBeLessThanOrEqual(6000);
      expect(embed.description!.endsWith('…')).toBe(true);
    });

    it('cuts fields from the end when the description is not enough', async () => {
      const { id } = await seed({});
      await t.database.admin.update(templates).set({
        embed: {
          title: 'Rules',
          fields: Array.from({ length: 7 }, (_, index) => ({ name: `Field ${index}`, value: '{user.display}' })),
          footer: { text: '{user.display}' },
        },
      });
      const embed = (await inHandler((ctx) => render(ctx, id, { 'user.display': 'x'.repeat(1000) })))!.embed!;
      expect(embedLength(embed)).toBeLessThanOrEqual(6000);
      // The first fields stay whole; the last one kept is cut, and every kept value is non-empty.
      expect(embed.fields!.slice(0, 4).map((field) => field.value)).toEqual(Array(4).fill('x'.repeat(1000)));
      expect(embed.fields!.every((field) => field.value.length > 0)).toBe(true);
      expect(embed.fields!.at(-1)!.value.endsWith('…')).toBe(true);
      expect(embed.title).toBe('Rules');
      expect(embed.footer!.text).toBe('x'.repeat(1000));
    });

    it('is unchanged without values', async () => {
      const { id } = await seed({});
      await t.database.admin.update(templates).set({ content: 'Hi {user.name}', embed: { title: '{server.name}' } });
      const message = await inHandler((ctx) => render(ctx, id));
      expect(message).toEqual({ content: 'Hi {user.name}', embed: { title: '{server.name}' } });
    });
  });
});
