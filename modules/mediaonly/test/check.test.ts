import { describe, expect, it } from 'vitest';
import { mediaProblem } from '../src/check.js';

const post = (content: string, ...spoilers: boolean[]) => ({ content, attachments: spoilers.map((spoiler) => ({ spoiler })) });

describe('mediaProblem', () => {
  it('rejects text only', () => {
    expect(mediaProblem(post('Just words'), false)).toBe('no-media');
    expect(mediaProblem(post(''), false)).toBe('no-media');
    expect(mediaProblem(post('see example.com or https:// alone'), false)).toBe('no-media');
  });

  it('passes any attachment, also audio or archives', () => {
    // Attachment types are not checked: an audio file or a zip counts like an image.
    expect(mediaProblem(post('My song', false), false)).toBeNull();
    expect(mediaProblem(post('', false, false), false)).toBeNull();
  });

  it('passes a bare link', () => {
    expect(mediaProblem(post('https://example.com/cat.png'), false)).toBeNull();
    expect(mediaProblem(post('look: http://example.com/a'), false)).toBeNull();
    expect(mediaProblem(post('<HTTPS://example.com/x>'), false)).toBeNull();
  });

  describe('require-spoiler', () => {
    it('rejects an attachment not marked spoiler', () => {
      expect(mediaProblem(post('', true, false), true)).toBe('not-spoilered');
    });

    it('rejects a link outside ||', () => {
      expect(mediaProblem(post('https://example.com/a'), true)).toBe('not-spoilered');
    });

    it('rejects when one of two links is outside ||', () => {
      expect(mediaProblem(post('||https://example.com/a|| and https://example.com/b'), true)).toBe('not-spoilered');
    });

    it('passes when everything is spoilered', () => {
      expect(mediaProblem(post('', true, true), true)).toBeNull();
      expect(mediaProblem(post('Two: ||https://example.com/a|| ||see https://example.com/b too||', true), true)).toBeNull();
    });

    it('still rejects text only as missing media', () => {
      expect(mediaProblem(post('||hidden words||'), true)).toBe('no-media');
    });
  });
});
