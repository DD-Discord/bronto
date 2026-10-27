import type { Listener } from './events.js';
import type { HandlerContext } from './types.js';

/** What one listener did when asked. */
export type AskOutcome =
  | { module: string; kind: 'answer'; value: unknown }
  | { module: string; kind: 'invalid' }
  | { module: string; kind: 'failed' }
  | { module: string; kind: 'timeout' };

/** How the answers of an ask's listeners combine into the result of `ctx.ask`. */
export interface AskStrategy<TResult, TState = unknown> {
  /** How long one listener may take before its outcome is `timeout`. */
  timeoutMs: number;
  initial(): TState;
  /** Folds one outcome in; `{ done }` stops asking further listeners. */
  next(state: TState, outcome: AskOutcome): { state: TState } | { done: TResult };
  /** The result once every listener has been asked. */
  finish(state: TState): TResult;
}

/** A question one module asks all others; listeners match it by object identity. */
export interface AskDefinition<TPayload, TAnswer, TResult> {
  readonly name: string;
  /** Owning module, set by defineModule. */
  owner: string | null;
  readonly strategy: AskStrategy<TResult, any>;
  /** Checks a listener's answer; a failed check becomes an `invalid` outcome. Without it every answer is accepted. */
  readonly validate?: (value: unknown) => boolean;
  /** Never set at runtime; carry the payload and answer types. */
  readonly payload?: TPayload;
  readonly answer?: TAnswer;
}

export function defineAsk<TPayload, TAnswer, TResult>(
  name: string,
  strategy: AskStrategy<TResult, any>,
  validate?: (value: unknown) => boolean,
): AskDefinition<TPayload, TAnswer, TResult> {
  return validate === undefined ? { name, owner: null, strategy } : { name, owner: null, strategy, validate };
}

export function askLabel(ask: AskDefinition<any, any, any>): string {
  return `${ask.owner ?? 'unowned'}.${ask.name}`;
}

/** Declares a listener answering a module's ask; modules list them in `listeners`. */
export function answer<TPayload, TAnswer>(
  ask: AskDefinition<TPayload, TAnswer, any>,
  handler: (ctx: HandlerContext, payload: TPayload) => Promise<TAnswer> | TAnswer,
): Listener {
  return { kind: 'ask', ask, handler };
}

/** How long a collector listener may take before it is skipped. */
export const COLLECTOR_TIMEOUT_MS = 1500;

/** One module's answer to a collector. */
export interface Collected<A> {
  module: string;
  value: A;
}

// Asks every listener; answers are appended in module order, while invalid, failed and timed-out listeners are skipped.
const collectorStrategy = (timeoutMs: number): AskStrategy<Collected<any>[], Collected<any>[]> => ({
  timeoutMs,
  initial: () => [],
  next(state, outcome) {
    return outcome.kind === 'answer' ? { state: [...state, { module: outcome.module, value: outcome.value }] } : { state };
  },
  finish: (state) => state,
});

/** A question one module asks all others to gather their answers; failing listeners are skipped. */
export function defineCollector<TPayload, TAnswer>(
  name: string,
  options: { timeoutMs?: number; validate?: (value: unknown) => value is TAnswer } = {},
): AskDefinition<TPayload, TAnswer, Collected<TAnswer>[]> {
  return defineAsk(name, collectorStrategy(options.timeoutMs ?? COLLECTOR_TIMEOUT_MS), options.validate);
}
