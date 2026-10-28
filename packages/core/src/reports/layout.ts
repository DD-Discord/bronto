import { ButtonStyle, ComponentType, MessageFlags, SeparatorSpacingSize, type APIMessageTopLevelComponent } from 'discord.js';
import type { WebhookMessage } from '../webhooks/index.js';

/** Discord's limit on the displayable text of one message: text displays and button labels together. */
export const MAX_REPORT_TEXT = 4000;

export type ReportBlock =
  | { kind: 'text'; text: string }
  | { kind: 'separator' }
  | { kind: 'file'; name: string }
  | { kind: 'button'; label: string; url: string };

export interface ReportLayout {
  accent: number;
  blocks: ReportBlock[];
  files: { name: string; data: Buffer }[];
}

const ZERO_WIDTH_SPACE = '​';

/** Wraps text in a code block; fences inside the text cannot close it. */
export function fenced(text: string, lang = ''): string {
  // A zero-width space between adjacent backticks leaves no run of three, however long the run.
  const safe = text.replace(/`(?=`)/g, `\`${ZERO_WIDTH_SPACE}`);
  return `\`\`\`${lang}\n${safe}\n\`\`\``;
}

function toComponents({ accent, blocks }: ReportLayout): APIMessageTopLevelComponent[] {
  const children: unknown[] = [];
  const buttons: unknown[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') children.push({ type: ComponentType.TextDisplay, content: block.text });
    else if (block.kind === 'separator') children.push({ type: ComponentType.Separator, divider: true, spacing: SeparatorSpacingSize.Small });
    else if (block.kind === 'file') children.push({ type: ComponentType.File, file: { url: `attachment://${block.name}` } });
    else buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, label: block.label, url: block.url });
  }
  if (buttons.length > 0) children.push({ type: ComponentType.ActionRow, components: buttons });
  return [{ type: ComponentType.Container, accent_color: accent, components: children }] as unknown as APIMessageTopLevelComponent[];
}

const textSize = (blocks: ReportBlock[]) =>
  blocks.reduce((sum, block) => sum + (block.kind === 'text' ? block.text.length : block.kind === 'button' ? block.label.length : 0), 0);

/**
 * A components-v2 message from the first mode whose blocks fit the text limit, else the last mode. Modes run from
 * everything inline to the most text in attachments; `build` pushes attachments to `layout.files` itself.
 */
export function fitReport<M>(modes: readonly M[], accent: number, build: (mode: M, layout: ReportLayout) => ReportBlock[]): WebhookMessage {
  let layout: ReportLayout = { accent, blocks: [], files: [] };
  for (const mode of modes) {
    layout = { accent, blocks: [], files: [] };
    layout.blocks = build(mode, layout);
    if (textSize(layout.blocks) <= MAX_REPORT_TEXT) break;
  }
  return {
    components: toComponents(layout),
    ...(layout.files.length > 0 && { files: layout.files }),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

/** A section with a copy of a text, inline or (`inFile`) as an attachment. */
export function textSection(title: string, text: string, inFile: boolean, layout: ReportLayout, fileName = 'post.txt'): ReportBlock[] {
  if (!inFile) return [{ kind: 'text', text: `**${title}**\n${fenced(text)}` }];
  layout.files.push({ name: fileName, data: Buffer.from(text) });
  return [{ kind: 'text', text: `**${title}**` }, { kind: 'file', name: fileName }];
}
