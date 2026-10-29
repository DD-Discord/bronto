import { DiscordAPIError, RESTJSONErrorCodes } from 'discord.js';

/** Whether Discord reports the channel (or thread) as deleted. */
export const isUnknownChannel = (error: unknown): boolean =>
  error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel;

/** Whether Discord reports the message or its channel as deleted. */
export const isGone = (error: unknown): boolean =>
  isUnknownChannel(error) || (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage);
