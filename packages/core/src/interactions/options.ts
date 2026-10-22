import {
  ApplicationCommandOptionType,
  type APIApplicationCommandBasicOption,
  type Attachment,
  type ChannelType,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
  type User,
} from 'discord.js';
import { formatDuration, parseDuration } from './duration.js';
import { UserError } from './errors.js';
import type { HandlerContext } from '../runtime/types.js';

export type OptionKind = 'string' | 'integer' | 'number' | 'boolean' | 'user' | 'channel' | 'role' | 'mentionable' | 'attachment';

export interface Choice<V extends string | number = string | number> {
  name: string;
  value: V;
}

/** Raw values of a handler's options as typed so far, by option name; unset options are absent or `undefined`. */
export type AutocompleteOptions = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * Suggests values while the user types; runs as a handler of the command's module. `options` holds the raw values of
 * the handler's options, the focused one included.
 */
export type Autocomplete = (ctx: HandlerContext, query: string, options: AutocompleteOptions) => Choice[] | Promise<Choice[]>;

export interface OptionDefinition<TValue, TRequired extends boolean = boolean> {
  readonly kind: OptionKind;
  readonly description: string;
  readonly required: TRequired;
  readonly choices?: readonly Choice[];
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly channelTypes?: readonly ChannelType[];
  readonly autocomplete?: Autocomplete;
  /** Turns the raw Discord value into the option's value; may throw a `UserError`. */
  readonly parse?: (raw: unknown) => TValue;
  /** Never set; carries the value type. */
  readonly __value?: TValue;
}

export type OptionMap = Record<string, OptionDefinition<any, boolean>>;

export type OptionValue<O> = O extends OptionDefinition<infer V, infer R> ? (R extends true ? V : V | null) : never;

export type OptionValues<O extends OptionMap> = { [K in keyof O]: OptionValue<O[K]> };

interface BaseInput<R extends boolean> {
  description: string;
  required?: R;
}

interface TextInput<R extends boolean> extends BaseInput<R> {
  choices?: readonly Choice<string>[];
  minLength?: number;
  maxLength?: number;
  autocomplete?: Autocomplete;
}

interface NumberInput<R extends boolean> extends BaseInput<R> {
  choices?: readonly Choice<number>[];
  min?: number;
  max?: number;
  autocomplete?: Autocomplete;
}

interface DurationInput<R extends boolean> extends BaseInput<R> {
  /** Bounds in milliseconds, checked after parsing and never sent to Discord. */
  min?: number;
  max?: number;
}

interface ChannelInput<R extends boolean> extends BaseInput<R> {
  channelTypes?: readonly ChannelType[];
}

function build<V, R extends boolean>(kind: OptionKind, input: BaseInput<R> & Partial<OptionDefinition<V>>): OptionDefinition<V, R> {
  if (input.choices !== undefined && input.autocomplete !== undefined) {
    throw new Error(`Option "${input.description}" can have either choices or autocomplete, not both.`);
  }
  return { ...input, kind, required: (input.required ?? false) as R };
}

/** Option builders; the key an option is listed under in `options` is its name. */
export const opt = {
  string: <const R extends boolean = false>(input: TextInput<R>) => build<string, R>('string', input),
  integer: <const R extends boolean = false>(input: NumberInput<R>) => build<number, R>('integer', input),
  number: <const R extends boolean = false>(input: NumberInput<R>) => build<number, R>('number', input),
  /** Text like `1h 30m`, read as milliseconds. */
  duration: <const R extends boolean = false>(input: DurationInput<R>) => durationOption(input),
  boolean: <const R extends boolean = false>(input: BaseInput<R>) => build<boolean, R>('boolean', input),
  user: <const R extends boolean = false>(input: BaseInput<R>) => build<User, R>('user', input),
  channel: <const R extends boolean = false>(input: ChannelInput<R>) => build<GuildBasedChannel, R>('channel', input),
  role: <const R extends boolean = false>(input: BaseInput<R>) => build<Role, R>('role', input),
  mentionable: <const R extends boolean = false>(input: BaseInput<R>) =>
    build<GuildMember | User | Role, R>('mentionable', input),
  attachment: <const R extends boolean = false>(input: BaseInput<R>) => build<Attachment, R>('attachment', input),
};

function durationOption<R extends boolean>({ min, max, ...input }: DurationInput<R>): OptionDefinition<number, R> {
  const lower = min ?? 0;
  return build<number, R>('string', {
    ...input,
    maxLength: 32,
    parse: (raw) => {
      const ms = parseDuration(String(raw));
      if (ms < lower || (max !== undefined && ms > max)) {
        throw new UserError(
          max === undefined
            ? `Enter a duration of at least \`${formatDuration(lower)}\`.`
            : `Enter a duration between \`${formatDuration(lower)}\` and \`${formatDuration(max)}\`.`,
        );
      }
      return ms;
    },
  });
}

const API_TYPES: Record<OptionKind, ApplicationCommandOptionType> = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
  mentionable: ApplicationCommandOptionType.Mentionable,
  attachment: ApplicationCommandOptionType.Attachment,
};

const NAME = /^[a-z0-9_-]{1,32}$/;

export function assertName(kind: string, name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`${kind} name "${name}" must be 1 to 32 lowercase letters, digits, "-" or "_".`);
  }
}

export function assertDescription(kind: string, name: string, description: string): void {
  if (description.length < 1 || description.length > 100) {
    throw new Error(`${kind} "${name}" needs a description of 1 to 100 characters.`);
  }
}

/** The Discord JSON for one option; `required` overrides the option's own setting (CRUD reuses options). */
export function optionToJson(
  name: string,
  option: OptionDefinition<unknown>,
  required: boolean = option.required,
): APIApplicationCommandBasicOption {
  assertName('Option', name);
  assertDescription('Option', name, option.description);
  const json: Record<string, unknown> = {
    type: API_TYPES[option.kind],
    name,
    description: option.description,
    required,
  };
  if (option.choices !== undefined) json.choices = option.choices.map(({ name: label, value }) => ({ name: label, value }));
  if (option.min !== undefined) json.min_value = option.min;
  if (option.max !== undefined) json.max_value = option.max;
  if (option.minLength !== undefined) json.min_length = option.minLength;
  if (option.maxLength !== undefined) json.max_length = option.maxLength;
  if (option.channelTypes !== undefined) json.channel_types = [...option.channelTypes];
  if (option.autocomplete !== undefined) json.autocomplete = true;
  return json as unknown as APIApplicationCommandBasicOption;
}

/** Where option values come from; discord.js's `interaction.options` fits. */
export interface OptionSource {
  get(name: string): unknown;
}

interface RawOption {
  value?: unknown;
  user?: unknown;
  member?: unknown;
  channel?: unknown;
  role?: unknown;
  attachment?: unknown;
}

function valueOf(kind: OptionKind, raw: RawOption): unknown {
  switch (kind) {
    case 'user':
      return raw.user;
    case 'channel':
      return raw.channel;
    case 'role':
      return raw.role;
    case 'mentionable':
      return raw.member ?? raw.user ?? raw.role;
    case 'attachment':
      return raw.attachment;
    default:
      return raw.value;
  }
}

/** Reads every declared option; omitted optional options are null. */
export function readOptions<O extends OptionMap>(options: O, source: OptionSource): OptionValues<O> {
  const values: Record<string, unknown> = {};
  for (const [name, option] of Object.entries(options)) {
    const raw = source.get(name) as RawOption | null;
    const value = raw === null ? null : (valueOf(option.kind, raw) ?? null);
    if (value === null && option.required) throw new Error(`Required option "${name}" is missing.`);
    values[name] = value === null || option.parse === undefined ? value : option.parse(value);
  }
  return values as OptionValues<O>;
}
