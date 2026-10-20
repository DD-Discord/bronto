import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

export class UnknownMessageError extends Error {
  constructor() {
    super('Unknown message');
    this.name = 'UnknownMessageError';
  }
}

export class UnknownWebhookError extends Error {
  constructor() {
    super('Unknown webhook');
    this.name = 'UnknownWebhookError';
  }
}

export class MissingWebhookPermissionError extends Error {
  readonly channelId: string;

  constructor(channelId: string) {
    super(`Missing Manage Webhooks in channel ${channelId}`);
    this.name = 'MissingWebhookPermissionError';
    this.channelId = channelId;
  }
}

/** Removes the request body (message text, files, sender) from a REST error so it never reaches logs. */
export function stripRequestBody<T>(error: T): T {
  if (error instanceof Error && 'requestBody' in error) delete (error as { requestBody?: unknown }).requestBody;
  return error;
}

/** Preserves recovery codes while removing webhook credentials and message bodies from errors. */
export async function withWebhookErrors<T>(token: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DiscordAPIError) {
      if (error.code === RESTJSONErrorCodes.UnknownMessage) throw new UnknownMessageError();
      if (error.code === RESTJSONErrorCodes.UnknownWebhook || error.code === RESTJSONErrorCodes.InvalidWebhookToken) throw new UnknownWebhookError();
    }
    const seen = new WeakSet<object>();
    const redact = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return;
      seen.add(value);
      if ('requestBody' in value) delete (value as { requestBody?: unknown }).requestBody;
      for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) continue;
        if (typeof descriptor.value === 'string' && token && descriptor.writable) {
          Object.defineProperty(value, key, { ...descriptor, value: descriptor.value.replaceAll(token, '…') });
        } else redact(descriptor.value);
      }
    };
    redact(error);
    throw error;
  }
}
