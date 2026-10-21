import { FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import type { TemplatesContext } from '../src/context.js';
import { templateImages, templates, type ImageSlot } from '../src/db/schema.js';
import { linkExpiry } from '../src/images.js';
import { render } from '../src/render.js';
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
        embed: (options.embed ?? null) as never,
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
});
