import { createHmac, timingSafeEqual } from 'node:crypto';

export const MIN_SECRET_LENGTH = 32;
const SIGNATURE_BYTES = 8;

/** Everything a component custom ID's signature covers. `userId` and `channelId` are null unless the definition binds them. */
export interface SignatureInput {
  kind: 'button' | 'modal';
  module: string;
  name: string;
  args: string[];
  guildId: string;
  userId: string | null;
  channelId: string | null;
  expiry: string | null;
}

/** Signs component custom IDs with the configured interaction secret (HMAC-SHA256, first 8 bytes, base64url). */
export class ComponentSigner {
  private readonly secret: string;

  constructor(secret: string) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`The interaction secret must be at least ${MIN_SECRET_LENGTH} characters.`);
    }
    this.secret = secret;
  }

  /** 11 base64url characters. */
  sign(input: SignatureInput): string {
    // A JSON array keeps fields from running into each other; the leading 1 versions the format.
    const data = JSON.stringify([
      1,
      input.kind,
      input.module,
      input.name,
      input.args,
      input.guildId,
      input.userId,
      input.channelId,
      input.expiry,
    ]);
    return createHmac('sha256', this.secret).update(data).digest().subarray(0, SIGNATURE_BYTES).toString('base64url');
  }

  /** Compares in constant time. */
  verify(input: SignatureInput, signature: string): boolean {
    const expected = Buffer.from(this.sign(input));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
