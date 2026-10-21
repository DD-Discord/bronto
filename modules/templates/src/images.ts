/** How long a download from Discord's CDN may take; a timeout counts as a failed download. */
export const DOWNLOAD_TIMEOUT_MS = 15_000;

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
