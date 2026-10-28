import { UserError } from '@bronto/core';
import { describe, expect, it } from 'vitest';
import { parseEmojis } from '../src/emojis.js';

const usable = (id: string) => id === '100000000000000200';

describe('parseEmojis', () => {
  it('accepts unicode emojis including skin tones and ZWJ sequences', () => {
    const thumbs = '\u{1F44D}\u{1F3FD}';
    const family = '\u{1F469}‍\u{1F469}‍\u{1F467}';
    const flag = '\u{1F1E9}\u{1F1EA}';
    expect(parseEmojis(`\u{1F44D} ${thumbs},${family}  ${flag} ❤️`, usable)).toEqual(['\u{1F44D}', thumbs, family, flag, '❤️']);
  });

  it('accepts custom emojis the bot can use, animated ones too', () => {
    expect(parseEmojis('<:party:100000000000000200> <a:dance:100000000000000200>', usable)).toEqual([
      '<:party:100000000000000200>',
      '<a:dance:100000000000000200>',
    ]);
  });

  it('refuses a custom emoji the bot cannot use, naming it', () => {
    expect(() => parseEmojis('\u{1F44D} <:other:100000000000000201>', usable)).toThrow(/<:other:100000000000000201>/);
    expect(() => parseEmojis('<:other:100000000000000201>', usable)).toThrow(UserError);
  });

  it('refuses more than five emojis', () => {
    expect(() => parseEmojis('\u{1F44D} \u{1F389} \u{1F525} \u{1F602} \u{1F600} \u{1F62E}', usable)).toThrow(/at most 5/);
  });

  it('refuses duplicates, naming them', () => {
    expect(() => parseEmojis('\u{1F44D} \u{1F389} \u{1F44D}', usable)).toThrow(/\u{1F44D}.*twice|twice.*\u{1F44D}/u);
  });

  it('refuses plain text and unfinished emoji, naming the token', () => {
    expect(() => parseEmojis('\u{1F44D} hello', usable)).toThrow(/hello/);
    expect(() => parseEmojis(':thumbsup:', usable)).toThrow(/:thumbsup:/);
    expect(() => parseEmojis('1', usable)).toThrow(/"1"|`1`/);
  });

  it('refuses an empty list', () => {
    expect(() => parseEmojis('  , ', usable)).toThrow(/at least one/);
  });
});
