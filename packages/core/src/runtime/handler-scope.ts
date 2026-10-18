import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModuleRuntime } from './context.js';
import type { HandlerContext } from './types.js';

/** The handler run code is executing in, for module APIs to borrow. */
export interface HandlerScope {
  /** A context for `runtime` in this run: same guild, actor and emit lifetime. Throws once the run finished. */
  contextFor(runtime: ModuleRuntime): HandlerContext;
}

const storage = new AsyncLocalStorage<HandlerScope>();

/** Runs `fn` with `scope` as the current handler run. */
export function runInHandlerScope<T>(scope: HandlerScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The handler run the current code belongs to, or null outside one. */
export function currentHandlerScope(): HandlerScope | null {
  return storage.getStore() ?? null;
}

/** Thrown when an API reads a handler field without a running handler. */
export function outsideHandlerError(): Error {
  return new Error('A module API was used outside a handler.');
}
