import { Collection, PermissionsBitField, type Interaction } from 'discord.js';

export type FakeResponseKind = 'reply' | 'deferReply' | 'update' | 'deferUpdate' | 'editReply' | 'followUp' | 'deleteReply' | 'showModal' | 'respond';

export interface FakeResponse {
  kind: FakeResponseKind;
  payload: unknown;
}

export interface FakeInteractionBase {
  guildId: string | null;
  channelId: string;
  userId: string;
  /** Makes every response method reject, as Discord does for an expired interaction. */
  rejectResponses: boolean;
  /** Whether the guild is in the client's cache; true by default. False fakes a guild the bot has not loaded yet. */
  cached: boolean;
  /** The member's permissions in the interaction's channel; every permission by default. */
  permissions: bigint;
  /** The largest file in bytes the bot may upload in the interaction's context; 10 MiB by default. */
  attachmentSizeLimit: number;
}

export type FakeCommandInput = Partial<FakeInteractionBase> & {
  command: string;
  group?: string;
  subcommand?: string;
  options?: Record<string, unknown>;
};

/** An uploaded modal file; `id` defaults to its position. */
export interface UploadedFile { id?: string; filename?: string; url?: string; size?: number; contentType?: string; [key: string]: unknown }

/** The IDs chosen in a mentionable select, by kind. */
export interface MentionableSelection { users?: string[]; roles?: string[]; members?: string[] }

/**
 * A mentionable select's choices by kind. A selected guild user appears in `users` and, in discord.js, usually in
 * `members` too; the fake fills `members` only from its input.
 */
interface MentionablesResult {
  members: Collection<string, { id: string }>;
  roles: Collection<string, { id: string }>;
  users: Collection<string, { id: string }>;
}

type Kind = 'command' | 'autocomplete' | 'button' | 'modal' | 'select';

interface Details {
  command?: string;
  group?: string;
  subcommand?: string;
  options?: Record<string, unknown>;
  focused?: string;
  customId?: string;
  fields?: Record<string, string>;
  uploads?: Record<string, UploadedFile[]>;
  checkboxes?: Record<string, boolean>;
  selections?: Record<string, string[]>;
  mentionables?: Record<string, MentionableSelection>;
  values?: string[];
}

/**
 * Stands in for a discord.js interaction in tests. It implements only what bronto's router uses and records every
 * response in `responses`.
 */
export class FakeInteraction {
  readonly responses: FakeResponse[] = [];
  readonly guildId: string | null;
  readonly channelId: string;
  readonly user: { id: string };
  readonly commandName: string | undefined;
  readonly customId: string | undefined;
  readonly values: string[];
  readonly memberPermissions: PermissionsBitField;
  readonly attachmentSizeLimit: number;
  replied = false;
  deferred = false;
  readonly options: {
    getSubcommand(required?: boolean): string | null;
    getSubcommandGroup(required?: boolean): string | null;
    get(name: string): Record<string, unknown> | null;
    getFocused(full: true): { name: string; type: number; value: string; focused: true };
  };
  readonly fields: {
    getTextInputValue(customId: string): string;
    getUploadedFiles(customId: string): Collection<string, UploadedFile> | null;
    getCheckbox(customId: string): boolean;
    getStringSelectValues(customId: string): readonly string[];
    getCheckboxGroup(customId: string): readonly string[];
    getRadioGroup(customId: string, required?: boolean): string | null;
    getSelectedChannels(customId: string, required?: boolean): Collection<string, { id: string }> | null;
    getSelectedRoles(customId: string, required?: boolean): Collection<string, { id: string }> | null;
    getSelectedMentionables(customId: string, required?: boolean): MentionablesResult | null;
  };
  private readonly kind: Kind;
  private readonly rejectResponses: boolean;
  private readonly cached: boolean;

  constructor(kind: Kind, base: Partial<FakeInteractionBase>, details: Details) {
    this.kind = kind;
    this.guildId = base.guildId === undefined ? 'g1' : base.guildId;
    this.channelId = base.channelId ?? 'c1';
    this.user = { id: base.userId ?? 'u1' };
    this.rejectResponses = base.rejectResponses ?? false;
    this.cached = base.cached ?? true;
    this.memberPermissions = new PermissionsBitField(base.permissions ?? PermissionsBitField.All);
    this.attachmentSizeLimit = base.attachmentSizeLimit ?? 10 * 1024 * 1024;
    this.commandName = details.command;
    this.customId = details.customId;
    this.values = details.values ?? [];
    const values = details.options ?? {};
    this.options = {
      getSubcommand: () => details.subcommand ?? null,
      getSubcommandGroup: () => details.group ?? null,
      get: (name) => {
        const value = values[name];
        if (value === undefined || value === null) return null;
        if (typeof value === 'object') return { name, type: 0, channel: value, role: value, user: value, attachment: value };
        return { name, type: 0, value };
      },
      getFocused: () => ({ name: details.focused ?? '', type: 3, value: String(values[details.focused ?? ''] ?? ''), focused: true }),
    };
    const fields = details.fields ?? {};
    const selection = (customId: string): string[] => {
      const ids = details.selections?.[customId];
      if (ids === undefined) throw new Error(`No modal field ${customId}`);
      return ids;
    };
    // Like discord.js, an empty selection reads as null and throws when required.
    const resolved = (customId: string, required = false): Collection<string, { id: string }> | null => {
      const ids = selection(customId);
      if (ids.length === 0) {
        if (required) throw new Error(`Required modal field ${customId} is empty`);
        return null;
      }
      return new Collection(ids.map((id) => [id, { id }]));
    };
    this.fields = {
      getStringSelectValues: selection,
      getCheckboxGroup: selection,
      getRadioGroup: (customId, required = false) => {
        const [first] = selection(customId);
        if (first === undefined && required) throw new Error(`Required modal field ${customId} is empty`);
        return first ?? null;
      },
      getSelectedChannels: resolved,
      getSelectedRoles: resolved,
      getSelectedMentionables: (customId, required = false) => {
        const chosen = details.mentionables?.[customId];
        if (chosen === undefined) throw new Error(`No modal field ${customId}`);
        const byId = (ids: string[] = []) => new Collection<string, { id: string }>(ids.map((id) => [id, { id }]));
        const result = { members: byId(chosen.members), roles: byId(chosen.roles), users: byId(chosen.users) };
        if (result.members.size + result.roles.size + result.users.size === 0) {
          if (required) throw new Error(`Required modal field ${customId} is empty`);
          return null;
        }
        return result;
      },
      getTextInputValue: (customId) => {
        const value = fields[customId];
        if (value === undefined) throw new Error(`No modal field ${customId}`);
        return value;
      },
      getUploadedFiles: (customId) => {
        const files = details.uploads?.[customId];
        if (files === undefined) throw new Error(`No modal field ${customId}`);
        if (files.length === 0) return null;
        return new Collection(files.map((file, index) => [file.id ?? String(index), { id: String(index), ...file, name: file.filename }]));
      },
      getCheckbox: (customId) => {
        const value = details.checkboxes?.[customId];
        if (value === undefined) throw new Error(`No modal field ${customId}`);
        return value;
      },
    };
  }

  asInteraction(): Interaction {
    return this as unknown as Interaction;
  }

  inCachedGuild(): boolean {
    return this.guildId !== null && this.cached;
  }

  inGuild(): boolean {
    return this.guildId !== null;
  }

  isChatInputCommand(): boolean {
    return this.kind === 'command';
  }

  isAutocomplete(): boolean {
    return this.kind === 'autocomplete';
  }

  isButton(): boolean {
    return this.kind === 'button';
  }

  isModalSubmit(): boolean {
    return this.kind === 'modal';
  }

  isStringSelectMenu(): boolean {
    return this.kind === 'select';
  }

  isRepliable(): boolean {
    return this.kind !== 'autocomplete';
  }

  reply(payload: unknown): Promise<void> {
    return this.record('reply', payload, () => {
      this.replied = true;
    });
  }

  deferReply(payload: unknown): Promise<void> {
    return this.record('deferReply', payload, () => {
      this.deferred = true;
    });
  }

  update(payload: unknown): Promise<void> {
    return this.record('update', payload, () => {
      this.replied = true;
    });
  }

  deferUpdate(): Promise<void> {
    return this.record('deferUpdate', undefined, () => {
      this.deferred = true;
    });
  }

  editReply(payload: unknown): Promise<void> {
    return this.record('editReply', payload);
  }

  followUp(payload: unknown): Promise<void> {
    return this.record('followUp', payload);
  }

  deleteReply(): Promise<void> {
    return this.record('deleteReply', undefined);
  }

  showModal(payload: unknown): Promise<void> {
    return this.record('showModal', payload, () => {
      this.replied = true;
    });
  }

  respond(payload: unknown): Promise<void> {
    return this.record('respond', payload);
  }

  private async record(kind: FakeResponseKind, payload: unknown, apply?: () => void): Promise<void> {
    if (this.rejectResponses) throw new Error('Unknown interaction');
    this.responses.push({ kind, payload });
    apply?.();
  }
}

export function fakeCommand(input: FakeCommandInput): FakeInteraction {
  return new FakeInteraction('command', input, input);
}

export function fakeAutocomplete(input: FakeCommandInput & { focused: string }): FakeInteraction {
  return new FakeInteraction('autocomplete', input, input);
}

export function fakeButton(input: Partial<FakeInteractionBase> & { customId: string }): FakeInteraction {
  return new FakeInteraction('button', input, input);
}

export function fakeModal(
  input: Partial<FakeInteractionBase> & {
    customId: string;
    fields?: Record<string, string>;
    uploads?: Record<string, UploadedFile[]>;
    checkboxes?: Record<string, boolean>;
    /** Chosen values per field, read by every select, checkbox-group, radio and entity-select getter. */
    selections?: Record<string, string[]>;
    mentionables?: Record<string, MentionableSelection>;
  },
): FakeInteraction {
  return new FakeInteraction('modal', input, input);
}

export function fakeSelect(input: Partial<FakeInteractionBase> & { customId: string; values: string[] }): FakeInteraction {
  return new FakeInteraction('select', input, input);
}
