import type { Listener } from './events.js';
import type { HandlerContext } from './types.js';

/** What one listener did when asked. */
export type AskOutcome =
  | { module: string; kind: 'answer'; value: unknown }
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
  /** Never set at runtime; carry the payload and answer types. */
  readonly payload?: TPayload;
  readonly answer?: TAnswer;
}

export function defineAsk<TPayload, TAnswer, TResult>(
  name: string,
  strategy: AskStrategy<TResult, any>,
): AskDefinition<TPayload, TAnswer, TResult> {
  return { name, owner: null, strategy };
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
