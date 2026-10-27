import { answer, askLabel, defineAsk, type AskDefinition, type AskStrategy } from './asks.js';
import type { Listener } from './events.js';
import type { HandlerContext } from './types.js';

/** How long a gate listener may take to answer before it counts as a denial. */
export const GATE_TIMEOUT_MS = 5000;

/** What a gate listener returns to veto the action; returning nothing allows it. */
export interface GateVerdict {
  deny: string;
}

/** The answer of `ctx.check`: allowed, or the reasons of the denial. */
export type GateResult = { allowed: true } | { allowed: false; reasons: string[] };

/** A question one module asks all others ("may this happen?"). */
export type GateDefinition<TPayload> = AskDefinition<TPayload, GateVerdict | void, GateResult>;

const denied = (reason: string): { done: GateResult } => ({ done: { allowed: false, reasons: [reason] } });

// Only no answer allows; `{ deny: '<reason>' }` denies with the reason, anything else is an invalid answer (fail
// closed). The first denial wins.
const gateStrategy: AskStrategy<GateResult, null> = {
  timeoutMs: GATE_TIMEOUT_MS,
  initial: () => null,
  next(state, outcome) {
    if (outcome.kind === 'timeout') return denied(`${outcome.module} did not answer in time`);
    if (outcome.kind === 'failed') return denied(`${outcome.module} failed to answer`);
    const verdict = outcome.value;
    if (verdict === undefined) return { state };
    if (typeof verdict === 'object' && verdict !== null && 'deny' in verdict) {
      const { deny } = verdict;
      if (typeof deny === 'string' && deny !== '') return denied(deny);
    }
    return denied(`${outcome.module} gave an invalid answer`);
  },
  finish: () => ({ allowed: true }),
};

export function defineGate<TPayload>(name: string): GateDefinition<TPayload> {
  return defineAsk(name, gateStrategy);
}

export const gateLabel = askLabel;

/** Declares a listener for a module's gate; modules list them in `listeners`. */
export function gate<P>(
  definition: GateDefinition<P>,
  handler: (ctx: HandlerContext, payload: P) => Promise<GateVerdict | void> | GateVerdict | void,
): Listener {
  return answer(definition, handler);
}
