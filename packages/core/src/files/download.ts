/** How long a download from Discord's CDN may take; a timeout counts as a failed download. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;

/** The largest file a download reads; Discord's own upload limit for most servers. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Downloads a file of at most `maxBytes` within DOWNLOAD_TIMEOUT_MS. Throws on HTTP errors, timeouts and larger
 * files: a Content-Length over the cap is refused before reading, and the body is counted while it is read, since the
 * header can be missing or wrong.
 */
export async function downloadFile(url: string, maxBytes = MAX_DOWNLOAD_BYTES): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  const tooLarge = () => new Error(`The download is larger than ${maxBytes} bytes.`);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/** Refetch a link when it expires within this long. */
export const REFRESH_MARGIN_MS = 3_600_000;

/** When a signed Discord CDN link stops working, from its hex `ex` (unix seconds) parameter; null if absent or malformed. */
export function linkExpiry(url: string): Date | null {
  let value: string | null;
  try {
    value = new URL(url).searchParams.get('ex');
  } catch {
    return null;
  }
  if (value === null || !/^[0-9a-f]+$/i.test(value)) return null;
  const seconds = Number.parseInt(value, 16);
  return Number.isSafeInteger(seconds) ? new Date(seconds * 1000) : null;
}
