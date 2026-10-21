import type { Listener } from './events.js';
import type { HandlerContext } from './types.js';

/** How long a gate listener may take to answer before it counts as a denial. */
export const GATE_TIMEOUT_MS = 5000;

/** A question one module asks all others ("may this happen?"); listeners match it by object identity. */
export interface GateDefinition<TPayload> {
  readonly name: string;
  /** Owning module, set by defineModule. */
  owner: string | null;
  /** Never set at runtime; carries the payload type. */
  readonly payload?: TPayload;
}

/** What a gate listener returns to veto the action; returning nothing allows it. */
export interface GateVerdict {
  deny: string;
}

/** The answer of `ctx.check`: allowed, or the reasons of the denial. */
export type GateResult = { allowed: true } | { allowed: false; reasons: string[] };

export function defineGate<TPayload>(name: string): GateDefinition<TPayload> {
  return { name, owner: null };
}

export function gateLabel(gate: GateDefinition<unknown>): string {
  return `${gate.owner ?? 'unowned'}.${gate.name}`;
}

/** Declares a listener for a module's gate; modules list them in `listeners`. */
export function gate<P>(
  definition: GateDefinition<P>,
  handler: (ctx: HandlerContext, payload: P) => Promise<GateVerdict | void> | GateVerdict | void,
): Listener {
  return { kind: 'gate', gate: definition, handler };
}
