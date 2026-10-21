import { Collection, type Interaction } from 'discord.js';

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
}

export type FakeCommandInput = Partial<FakeInteractionBase> & {
  command: string;
  group?: string;
  subcommand?: string;
  options?: Record<string, unknown>;
};

/** An uploaded modal file; `id` defaults to its position. */
export interface UploadedFile { id?: string; filename?: string; url?: string; size?: number; contentType?: string; [key: string]: unknown }

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
    this.fields = {
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
  },
): FakeInteraction {
  return new FakeInteraction('modal', input, input);
}

export function fakeSelect(input: Partial<FakeInteractionBase> & { customId: string; values: string[] }): FakeInteraction {
  return new FakeInteraction('select', input, input);
}
