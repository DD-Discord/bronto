import type { ButtonContext, ModalContext } from './context.js';
import type { ComponentSigner, SignatureInput } from './signing.js';

const MAX_CUSTOM_ID = 100;
const COMPONENT_NAME = /^[a-z0-9_-]{1,32}$/;
const EXPIRY = /^[0-9a-z]{1,12}$/;

interface ComponentBase {
  readonly name: string;
  /** Owning module, set by defineModule. */
  owner: string | null;
  /** Replies and automatic defers are visible only to the user unless a reply says otherwise. */
  readonly ephemeral?: boolean;
  /** Whom its custom IDs are signed for besides the server; checked against the interaction that uses them. */
  readonly bind: ComponentBinding;
  /** How long its custom IDs stay valid, or null for no limit. */
  readonly expiresAfterMs: number | null;
}

export interface ComponentBinding {
  readonly user: boolean;
  readonly channel: boolean;
}

/** The server, user and channel a custom ID is signed for or used in. */
export interface CustomIdTarget {
  guildId: string;
  userId: string | null;
  channelId: string | null;
}

export type CustomIdCheck = { ok: true; args: string[] } | { ok: false; reason: 'invalid' | 'expired' };

export interface ButtonDefinition extends ComponentBase {
  readonly kind: 'button';
  execute(ctx: ButtonContext, args: string[]): unknown;
}

export interface ModalDefinition extends ComponentBase {
  readonly kind: 'modal';
  execute(ctx: ModalContext, args: string[]): unknown;
}

export type ComponentDefinition = ButtonDefinition | ModalDefinition;

function base(
  name: string,
  bind: ComponentBinding,
  expiresAfterMs: number | undefined,
): Pick<ComponentBase, 'name' | 'owner' | 'bind' | 'expiresAfterMs'> {
  if (!COMPONENT_NAME.test(name)) {
    throw new Error(`Component name "${name}" must be 1 to 32 lowercase letters, digits, "-" or "_".`);
  }
  if (expiresAfterMs !== undefined && (!Number.isSafeInteger(expiresAfterMs) || expiresAfterMs <= 0)) {
    throw new Error(`Component "${name}": expiresAfterMs must be a positive whole number of milliseconds.`);
  }
  return { name, owner: null, bind, expiresAfterMs: expiresAfterMs ?? null };
}

export function defineButton(input: {
  name: string;
  /** Also binds IDs to the user and/or channel they are signed for; both off by default. */
  bind?: { user?: boolean; channel?: boolean };
  expiresAfterMs?: number;
  ephemeral?: boolean;
  execute: ButtonDefinition['execute'];
}): ButtonDefinition {
  const bind = { user: input.bind?.user ?? false, channel: input.bind?.channel ?? false };
  return { ...base(input.name, bind, input.expiresAfterMs), kind: 'button', ephemeral: input.ephemeral, execute: input.execute };
}

export function defineModal(input: {
  name: string;
  /** Modals are always bound to the user; `channel` also binds them to the channel. */
  bind?: { channel?: boolean };
  expiresAfterMs?: number;
  ephemeral?: boolean;
  execute: ModalDefinition['execute'];
}): ModalDefinition {
  if ((input.bind as { user?: unknown } | undefined)?.user === false) {
    throw new Error(`Modal "${input.name}" is always bound to its user.`);
  }
  const bind = { user: true, channel: input.bind?.channel ?? false };
  return { ...base(input.name, bind, input.expiresAfterMs), kind: 'modal', ephemeral: input.ephemeral, execute: input.execute };
}

/**
 * Builds a signed custom ID `<module>:<name>[:<arg>…][:<expiry>]:<signature>` for `target`. The user and channel count
 * only when the definition binds them; `now` is in milliseconds.
 */
export function createCustomId(
  signer: ComponentSigner,
  component: ComponentDefinition,
  target: CustomIdTarget,
  args: string[],
  now: number,
): string {
  const { name, owner } = component;
  if (owner === null) throw new Error(`Component "${name}" is not part of a module yet; list it in defineModule.`);
  for (const arg of args) {
    if (arg.includes(':')) throw new Error(`Custom ID arguments must not contain ":" (got "${arg}").`);
  }
  if (component.bind.user && target.userId === null) {
    throw new Error(`Component "${name}" is bound to a user and needs a user to sign for.`);
  }
  if (component.bind.channel && target.channelId === null) {
    throw new Error(`Component "${name}" is bound to a channel and needs a channel to sign for.`);
  }
  const expiry =
    component.expiresAfterMs === null ? null : Math.ceil((now + component.expiresAfterMs) / 1000).toString(36);
  const signature = signer.sign(signatureInput(component, owner, [...args], target, expiry));
  const id = [owner, name, ...args, ...(expiry === null ? [] : [expiry]), signature].join(':');
  if (id.length > MAX_CUSTOM_ID) throw new Error(`Custom ID "${id}" is longer than ${MAX_CUSTOM_ID} characters.`);
  return id;
}

/**
 * Checks a custom ID against `component` as used in `target` at `now` (milliseconds). The binding and expiry come from
 * the definition only; the expiry is checked after the signature, so a forged one is invalid rather than expired.
 */
export function checkCustomId(
  signer: ComponentSigner,
  component: ComponentDefinition,
  customId: string,
  target: CustomIdTarget,
  now: number,
): CustomIdCheck {
  const invalid: CustomIdCheck = { ok: false, reason: 'invalid' };
  const parsed = parseCustomId(customId);
  if (parsed === null || component.owner === null) return invalid;
  if (parsed.module !== component.owner || parsed.name !== component.name) return invalid;
  const rest = [...parsed.rest];
  const signature = rest.pop();
  if (signature === undefined) return invalid;
  let expiry: string | null = null;
  if (component.expiresAfterMs !== null) {
    expiry = rest.pop() ?? null;
    if (expiry === null || !EXPIRY.test(expiry)) return invalid;
  }
  if (!signer.verify(signatureInput(component, component.owner, rest, target, expiry), signature)) return invalid;
  if (expiry !== null && parseInt(expiry, 36) * 1000 < now) return { ok: false, reason: 'expired' };
  return { ok: true, args: rest };
}

function signatureInput(
  component: ComponentDefinition,
  owner: string,
  args: string[],
  target: CustomIdTarget,
  expiry: string | null,
): SignatureInput {
  return {
    kind: component.kind,
    module: owner,
    name: component.name,
    args,
    guildId: target.guildId,
    userId: component.bind.user ? target.userId : null,
    channelId: component.bind.channel ? target.channelId : null,
    expiry,
  };
}

/** Splits off the `<module>:<name>` prefix; `rest` holds the arguments, expiry and signature. */
export function parseCustomId(customId: string): { module: string; name: string; rest: string[] } | null {
  const [module, name, ...rest] = customId.split(':');
  if (module === undefined || name === undefined || module === '' || name === '') return null;
  return { module, name, rest };
}
