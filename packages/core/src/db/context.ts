import { AsyncLocalStorage } from 'node:async_hooks';

/** The guild and acting user the current code runs for; read by the database layer. */
export interface Scope {
  guildId: string | null;
  actorId: string | null;
  /** Deliveries waiting for the current transaction to commit; null outside a transaction. */
  pendingEvents: Array<() => void> | null;
}

const storage = new AsyncLocalStorage<Scope>();

/** Runs `fn` with `patch` overriding fields of the current scope. */
export function runInScope<T>(patch: Partial<Scope>, fn: () => T): T {
  const current = storage.getStore() ?? { guildId: null, actorId: null, pendingEvents: null };
  return storage.run({ ...current, ...patch }, fn);
}

export function currentGuildId(): string | null {
  return storage.getStore()?.guildId ?? null;
}

export function currentActor(): string | null {
  return storage.getStore()?.actorId ?? null;
}

/** Runs `deliver` after the current transaction commits, or now when there is none. */
export function afterCommit(deliver: () => void): void {
  const pending = storage.getStore()?.pendingEvents ?? null;
  if (pending === null) deliver();
  else pending.push(deliver);
}
