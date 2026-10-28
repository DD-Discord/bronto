import { UserError } from '@bronto/core';

const MAX_EMOJIS = 5;
const UNICODE_EMOJI = /^\p{RGI_Emoji}$/v;
const CUSTOM_EMOJI = /^<a?:\w+:(\d+)>$/;

/**
 * Splits a list of emojis on whitespace and commas. Each is a unicode emoji or a custom emoji `usable` accepts by
 * ID; 1 to 5 distinct ones. Throws a `UserError` naming the first bad token.
 */
export function parseEmojis(raw: string, usable: (id: string) => boolean): string[] {
  const tokens = raw.split(/[\s,]+/).filter((token) => token !== '');
  if (tokens.length === 0) throw new UserError('Give at least one emoji.');
  const seen = new Set<string>();
  for (const token of tokens) {
    const customId = CUSTOM_EMOJI.exec(token)?.[1];
    if (customId !== undefined ? !usable(customId) : !UNICODE_EMOJI.test(token)) {
      throw new UserError(
        customId !== undefined
          ? `I can't use the custom emoji ${token}; it has to be one of a server I'm in.`
          : `"${token}" is not an emoji. Use unicode emojis or custom emojis, separated by spaces.`,
      );
    }
    // A custom emoji is the same emoji whether or not it is written as animated.
    const identity = customId ?? token;
    if (seen.has(identity)) throw new UserError(`${token} appears twice; list each emoji once.`);
    seen.add(identity);
  }
  if (tokens.length > MAX_EMOJIS) throw new UserError(`Use at most ${MAX_EMOJIS} emojis; you gave ${tokens.length}.`);
  return tokens;
}
