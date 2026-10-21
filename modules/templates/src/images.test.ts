import { describe, expect, it } from 'vitest';
import { linkExpiry } from './images.js';

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
