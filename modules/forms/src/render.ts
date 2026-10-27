import { ComponentType, type APIAllowedMentions, type APIMessageTopLevelComponent } from 'discord.js';
import type { Answer } from './db/schema.js';
import type { Field } from './model.js';

/** Discord's limit on the displayable text of one Components V2 message. */
export const MAX_TEXT = 4000;
/** Discord's limit on components per message, nested ones included. */
export const MAX_COMPONENTS = 40;
/** Discord's limit on attachments per message. */
export const MAX_FILES = 10;

export interface RenderInput {
  formName: string;
  userId: string;
  username: string;
  submittedAt: Date;
  pingUserIds: string[];
  pingRoleIds: string[];
  fields: Field[];
  answers: Record<string, Answer>;
  files: { key: string; fieldId: string; name: string; size: number }[];
  /** Bytes of attachments per message. */
  uploadLimit: number;
}

export interface RenderedPart {
  /** Components V2; the poster sets the `IsComponentsV2` flag. */
  components: APIMessageTopLevelComponent[];
  /** Files attached to this part, in order. `name` is unique within the message and is the name the component references as `attachment://<name>`; upload the file under it. */
  files: { key: string; name: string }[];
  fileKeys: string[];
  allowedMentions: APIAllowedMentions;
}

type Kid =
  | { kind: 'text'; content: string }
  | { kind: 'file'; name: string }
  | { kind: 'gallery'; names: string[] };

interface Part {
  kids: Kid[];
  chars: number;
  components: number;
  files: { key: string; name: string }[];
  bytes: number;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIN_ROOM = 20;
/** Leaves room for the `<index>-` prefix within 100 characters. */
const MAX_NAME = 94;

/** Discord rewrites unusual characters in uploaded names, which would break the `attachment://` match. */
function safeName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_');
  if (clean.length <= MAX_NAME) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
  return clean.slice(0, MAX_NAME - ext.length) + ext;
}

const label = (text: string) => `**${text}**`;

/** Cuts `text` so the first piece is at most `room` characters: at a paragraph break, else a sentence end, else whitespace, else anywhere. */
function cutPoint(text: string, room: number): number {
  const usable = (cut: number) => cut > 0 && cut <= room && text.slice(0, cut).trim() !== '';
  const paragraph = text.lastIndexOf('\n\n', room - 2);
  if (paragraph >= 0 && usable(paragraph + 2)) return paragraph + 2;
  let sentence = -1;
  for (const match of text.slice(0, room).matchAll(/[.!?] /g)) {
    const end = match.index + 2;
    if (usable(end)) sentence = end;
  }
  if (sentence > 0) return sentence;
  for (let i = room - 1; i > 0; i--) {
    if (/\s/.test(text[i - 1]!) && usable(i)) return i;
  }
  const high = text.charCodeAt(room - 1);
  return high >= 0xd800 && high <= 0xdbff && room > 1 ? room - 1 : room;
}

function answerText(answer: Answer | undefined): string | null {
  if (!answer) return null;
  if ('text' in answer) return answer.text.trim() === '' ? null : answer.text;
  if ('choices' in answer) return answer.choices.length === 0 ? null : answer.choices.map((c) => `• ${c}`).join('\n');
  return null;
}

/** Turns one submission into Components V2 message parts that each stay within Discord's limits. */
export function renderSubmission(input: RenderInput): RenderedPart[] {
  const { formName, userId } = input;
  const followUpHeader = (n: number, total: number) => `-# ${formName} — <@${userId}> (${n}/${total})`;
  const reserved = followUpHeader(99, 99).length;

  const firstHeader = [
    `## ${formName}`,
    `<@${userId}> · ${input.username} · ${userId}`,
    `<t:${Math.floor(input.submittedAt.getTime() / 1000)}:F>`,
    ...(input.pingUserIds.length + input.pingRoleIds.length > 0
      ? [`-# ${[...input.pingRoleIds.map((id) => `<@&${id}>`), ...input.pingUserIds.map((id) => `<@${id}>`)].join(' ')}`]
      : []),
  ].join('\n');

  const parts: Part[] = [];
  let cur!: Part;
  const newPart = () => {
    cur = { kids: [], chars: parts.length === 0 ? firstHeader.length : reserved, components: 2, files: [], bytes: 0 };
    parts.push(cur);
  };
  newPart();
  const freshChars = reserved;

  const addText = (content: string) => {
    cur.kids.push({ kind: 'text', content });
    cur.chars += content.length;
    cur.components += 1;
  };
  const fits = (length: number) => cur.chars + length <= MAX_TEXT && cur.components + 1 <= MAX_COMPONENTS;

  const addBody = (title: string, body: string) => {
    let rest = body;
    let head = `${label(title)}\n`;
    for (;;) {
      const whole = head + rest;
      if (fits(whole.length)) return addText(whole);
      if (cur.kids.length > 0 && freshChars + whole.length <= MAX_TEXT) {
        newPart();
        continue;
      }
      const room = MAX_TEXT - cur.chars - head.length;
      if (cur.components + 1 > MAX_COMPONENTS || room < MIN_ROOM) {
        newPart();
        continue;
      }
      const cut = cutPoint(rest, room);
      addText(head + rest.slice(0, cut));
      rest = rest.slice(cut);
      head = `${label(title)} (continued)\n`;
      newPart();
    }
  };

  const addFiles = (title: string, files: RenderInput['files']) => {
    files.forEach((file) => {
      if (file.size > input.uploadLimit) throw new Error(`File "${file.name}" (${file.size} bytes) exceeds the upload limit of ${input.uploadLimit} bytes`);
    });
    for (const file of files) {
      const image = IMAGE.test(file.name);
      const last = cur.kids[cur.kids.length - 1];
      const extend = image && last?.kind === 'gallery';
      const need = image && !extend ? 2 : 1;
      if (cur.files.length >= MAX_FILES || cur.bytes + file.size > input.uploadLimit || cur.components + need > MAX_COMPONENTS) {
        newPart();
        addText(`${label(title)} (continued)`);
      }
      const name = `${cur.files.length + 1}-${safeName(file.name)}`;
      cur.files.push({ key: file.key, name });
      cur.bytes += file.size;
      const tail = cur.kids[cur.kids.length - 1];
      if (image && tail?.kind === 'gallery') {
        tail.names.push(name);
        cur.components += 1;
      } else if (image) {
        cur.kids.push({ kind: 'gallery', names: [name] });
        cur.components += 2;
      } else {
        cur.kids.push({ kind: 'file', name });
        cur.components += 1;
      }
    }
  };

  for (const field of input.fields) {
    if (field.type === 'file') {
      const files = input.files.filter((f) => f.fieldId === field.id);
      if (files.length === 0) continue;
      const title = label(field.label);
      const first = files[0]!;
      const need = IMAGE.test(first.name) ? 2 : 1;
      if (!fits(title.length) || cur.components + 1 + need > MAX_COMPONENTS || cur.files.length >= MAX_FILES || cur.bytes + first.size > input.uploadLimit) newPart();
      addText(title);
      addFiles(field.label, files);
    } else {
      const body = answerText(input.answers[field.id]);
      if (body !== null) addBody(field.label, body);
    }
  }

  const total = parts.length;
  return parts.map((part, index) => {
    const header = index === 0 ? firstHeader : followUpHeader(index + 1, total);
    const children = [
      { type: ComponentType.TextDisplay, content: header },
      ...part.kids.map((kid) =>
        kid.kind === 'text'
          ? { type: ComponentType.TextDisplay, content: kid.content }
          : kid.kind === 'file'
            ? { type: ComponentType.File, file: { url: `attachment://${kid.name}` } }
            : { type: ComponentType.MediaGallery, items: kid.names.map((name) => ({ media: { url: `attachment://${name}` } })) },
      ),
    ];
    return {
      components: [{ type: ComponentType.Container, components: children }] as unknown as APIMessageTopLevelComponent[],
      files: part.files,
      fileKeys: part.files.map((f) => f.key),
      allowedMentions: index === 0 ? { parse: [], users: input.pingUserIds, roles: input.pingRoleIds } : { parse: [] },
    };
  });
}
