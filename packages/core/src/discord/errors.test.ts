import { describe, expect, it } from 'vitest';
import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';
import { isGone, isUnknownChannel } from './errors.js';

const apiError = (code: number) => new DiscordAPIError({ code, message: 'Synthetic' }, code, 404, 'GET', '/x', {});

describe('gone-error helpers', () => {
  it.each([
    ['Unknown Channel', RESTJSONErrorCodes.UnknownChannel, true, true],
    ['Unknown Message', RESTJSONErrorCodes.UnknownMessage, false, true],
    ['Missing Access', RESTJSONErrorCodes.MissingAccess, false, false],
  ])('classifies %s', (_name, code, channel, gone) => {
    expect(isUnknownChannel(apiError(code))).toBe(channel);
    expect(isGone(apiError(code))).toBe(gone);
  });

  it('ignores other errors', () => {
    for (const error of [new Error('x'), null]) {
      expect(isUnknownChannel(error)).toBe(false);
      expect(isGone(error)).toBe(false);
    }
  });
});
