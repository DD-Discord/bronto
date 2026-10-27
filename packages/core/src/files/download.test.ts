import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile, linkExpiry, MAX_DOWNLOAD_BYTES } from './download.js';

describe('linkExpiry', () => {
  it('reads the hex ex parameter as unix seconds', () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=6a000000&is=6a000001&hm=abc';
    expect(linkExpiry(url)).toEqual(new Date(0x6a000000 * 1000));
  });

  it('returns null without an ex parameter', () => {
    expect(linkExpiry('https://cdn.discordapp.com/attachments/1/2/a.png')).toBeNull();
  });

  it.each(['?ex=', '?ex=zz', '?ex=-5', '?ex=12 34'])('returns null for the malformed query %s', (query) => {
    expect(linkExpiry(`https://cdn.discordapp.com/attachments/1/2/a.png${query}`)).toBeNull();
  });

  it('returns null for text that is not a URL', () => {
    expect(linkExpiry('not a url')).toBeNull();
  });
});

describe('downloadFile', () => {
  const URL_ = 'https://cdn.discordapp.com/attachments/1/2/a.png';
  const chunked = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
  const serve = (response: Response) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the bytes of a file within the cap', async () => {
    serve(new Response(chunked('abc', 'de')));
    expect((await downloadFile(URL_, 5)).toString()).toBe('abcde');
  });

  it('refuses a file whose Content-Length is over the cap without reading it', async () => {
    let pulled = false;
    const body = new ReadableStream(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    serve(new Response(body, { headers: { 'content-length': '6' } }));
    await expect(downloadFile(URL_, 5)).rejects.toThrow('larger than 5 bytes');
    expect(pulled).toBe(false);
  });

  it.each([
    ['without a Content-Length', {}],
    ['with a wrong Content-Length', { 'content-length': '2' }],
  ])('stops reading a body over the cap %s', async (_, headers) => {
    serve(new Response(chunked('abc', 'def', 'ghi'), { headers }));
    await expect(downloadFile(URL_, 5)).rejects.toThrow('larger than 5 bytes');
  });

  it('refuses an HTTP error', async () => {
    serve(new Response('gone', { status: 404 }));
    await expect(downloadFile(URL_)).rejects.toThrow('HTTP 404');
  });

  it('caps at 25 MB by default', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});
