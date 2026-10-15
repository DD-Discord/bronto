import type { ButtonContext, ModalContext } from './context.js';

const MAX_CUSTOM_ID = 100;
const COMPONENT_NAME = /^[a-z0-9_-]{1,32}$/;

interface ComponentBase {
  readonly name: string;
  /** Owning module, set by defineModule. */
  owner: string | null;
  /** Replies and automatic defers are visible only to the user unless a reply says otherwise. */
  readonly ephemeral?: boolean;
  /** The custom ID routing an interaction to this component, with `args` passed to execute. */
  customId(...args: string[]): string;
}

export interface ButtonDefinition extends ComponentBase {
  readonly kind: 'button';
  execute(ctx: ButtonContext, args: string[]): unknown;
}

export interface ModalDefinition extends ComponentBase {
  readonly kind: 'modal';
  execute(ctx: ModalContext, args: string[]): unknown;
}

export type ComponentDefinition = ButtonDefinition | ModalDefinition;

function base(name: string): Omit<ComponentBase, 'ephemeral'> {
  if (!COMPONENT_NAME.test(name)) {
    throw new Error(`Component name "${name}" must be 1 to 32 lowercase letters, digits, "-" or "_".`);
  }
  return {
    name,
    owner: null,
    customId(this: ComponentBase, ...args: string[]): string {
      if (this.owner === null) throw new Error(`Component "${name}" is not part of a module yet; list it in defineModule.`);
      for (const arg of args) {
        if (arg.includes(':')) throw new Error(`Custom ID arguments must not contain ":" (got "${arg}").`);
      }
      const id = [this.owner, name, ...args].join(':');
      if (id.length > MAX_CUSTOM_ID) throw new Error(`Custom ID "${id}" is longer than ${MAX_CUSTOM_ID} characters.`);
      return id;
    },
  };
}

export function defineButton(input: {
  name: string;
  ephemeral?: boolean;
  execute: ButtonDefinition['execute'];
}): ButtonDefinition {
  return { ...base(input.name), kind: 'button', ephemeral: input.ephemeral, execute: input.execute };
}

export function defineModal(input: {
  name: string;
  ephemeral?: boolean;
  execute: ModalDefinition['execute'];
}): ModalDefinition {
  return { ...base(input.name), kind: 'modal', ephemeral: input.ephemeral, execute: input.execute };
}

export function parseCustomId(customId: string): { module: string; name: string; args: string[] } | null {
  const [module, name, ...args] = customId.split(':');
  if (module === undefined || name === undefined || module === '' || name === '') return null;
  return { module, name, args };
}
