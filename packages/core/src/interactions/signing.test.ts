import { describe, expect, it } from 'vitest';
import { ComponentSigner, type SignatureInput } from './signing.js';

const signer = new ComponentSigner('s'.repeat(32));
const input: SignatureInput = {
  kind: 'button', module: 'notes', name: 'text', args: ['n1'], guildId: 'g1', userId: null, channelId: null, expiry: null,
};

describe('ComponentSigner', () => {
  it('makes 11 URL-safe characters', () => {
    expect(signer.sign(input)).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('verifies only the exact input', () => {
    const signature = signer.sign(input);
    expect(signer.verify(input, signature)).toBe(true);
    for (const changed of [
      { ...input, kind: 'modal' as const },
      { ...input, args: ['n2'] },
      { ...input, args: ['n1', ''] },
      { ...input, guildId: 'g2' },
      { ...input, userId: 'u1' },
      { ...input, channelId: 'c1' },
      { ...input, expiry: 'zz' },
      { ...input, module: 'other' },
      { ...input, name: 'other' },
    ]) {
      expect(signer.verify(changed, signature)).toBe(false);
    }
    expect(signer.verify(input, signature.slice(0, 10))).toBe(false);
    expect(new ComponentSigner('t'.repeat(32)).verify(input, signature)).toBe(false);
  });

  it('refuses short secrets', () => {
    expect(() => new ComponentSigner('short')).toThrow('at least 32');
  });
});
