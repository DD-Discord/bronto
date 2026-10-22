import { UserError } from '@bronto/core';
import { sendableEmbed, type TemplateMessage } from './content.js';

const MESSAGE_LINK =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/;
const FENCE = /^```[a-z]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i;

export type ParsedBody =
  | { kind: 'link'; channelId: string; messageId: string; guildId: string }
  | { kind: 'json'; message: TemplateMessage }
  | { kind: 'text'; content: string };

function invalid(reason: string): UserError {
  return new UserError(`That isn't template JSON: ${reason}`);
}

/** The text inside a surrounding ``` fence, or the trimmed text when there is none. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const match = FENCE.exec(trimmed);
  return match === null ? trimmed : match[1]!.trim();
}

/** A template from `{ content?, embeds?: [embed, …] }` or `{ content?, embed? }` JSON; only the first embed is kept. */
export function parseTemplateJson(text: string): TemplateMessage {
  let root: unknown;
  try {
    root = JSON.parse(unfence(text));
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : 'it is not valid JSON.');
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw invalid('the top level must be an object.');
  const record = root as Record<string, unknown>;
  if (record.content !== undefined && typeof record.content !== 'string') throw invalid('"content" must be text.');
  let embed: unknown = record.embed;
  if (record.embeds !== undefined) {
    if (!Array.isArray(record.embeds)) throw invalid('"embeds" must be a list.');
    embed = record.embeds[0];
  }
  return { content: record.content ?? '', embed: sendableEmbed(embed) };
}

/** Classifies a pasted body as a message link, template JSON or plain text. */
export function parseBody(text: string): ParsedBody {
  const link = MESSAGE_LINK.exec(text.trim());
  if (link !== null) return { kind: 'link', guildId: link[1]!, channelId: link[2]!, messageId: link[3]! };
  const candidate = text.trim();
  if (candidate.startsWith('{') || candidate.startsWith('```')) {
    return { kind: 'json', message: parseTemplateJson(candidate) };
  }
  return { kind: 'text', content: text };
}

/** The template as importable JSON, 2-space indented. */
export function exportJson(message: TemplateMessage): string {
  const out: { content: string; embeds?: unknown[] } = { content: message.content };
  if (message.embed !== null) out.embeds = [message.embed];
  return JSON.stringify(out, null, 2);
}
